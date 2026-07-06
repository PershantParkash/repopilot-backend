// analyzer/dependency-graph.service.ts
import { Injectable } from '@nestjs/common';
import { Project, SourceFile } from 'ts-morph';
import * as fs from 'fs';
import * as path from 'path';

const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/.vercel/**',
  '**/coverage/**',
  '**/*.d.ts',
];

export interface DependencyEdge {
  from: string;
  to: string;
  kind: 'import' | 're-export';
  isTypeOnly: boolean;
}

export interface DependencyGraph {
  nodes: string[];
  edges: DependencyEdge[];
  externalDependencies: Record<string, string[]>;
}

export interface DependencyGraphSummary {
  nodes: number;
  edges: number;
  circularDependencies: number;
  maxDepth: number;
  externalPackages: number;
}

@Injectable()
export class DependencyGraphService {
  build(localPath: string): DependencyGraph {
    const project = this.createProject(localPath);

    project.addSourceFilesAtPaths([
      path.join(localPath, '**/*.{ts,tsx,js,jsx}'),
      ...IGNORE_GLOBS.map((g) => `!${path.join(localPath, g)}`),
    ]);

    const nodes: string[] = [];
    const edges: DependencyEdge[] = [];
    const externalDependencies: Record<string, string[]> = {};

    for (const sourceFile of project.getSourceFiles()) {
      const fromId = this.toRelativeId(localPath, sourceFile.getFilePath());
      nodes.push(fromId);
      externalDependencies[fromId] = [];

      this.collectImports(sourceFile, localPath, fromId, edges, externalDependencies);
      this.collectReExports(sourceFile, localPath, fromId, edges, externalDependencies);
    }

    return { nodes, edges, externalDependencies };
  }

  /**
   * Cheap, fixed-size stats derived from an already-built graph.
   * This is what goes in the default analysis response; `build()`'s
   * full output is only served from the dedicated /graph endpoint.
   */
  summarize(graph: DependencyGraph): DependencyGraphSummary {
    const externalPackages = new Set<string>();
    for (const pkgs of Object.values(graph.externalDependencies)) {
      pkgs.forEach((p) => externalPackages.add(p));
    }

    return {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      circularDependencies: this.countCircularDependencies(graph),
      maxDepth: this.computeMaxDepth(graph),
      externalPackages: externalPackages.size,
    };
  }

  // ---------- project setup ----------

  private createProject(localPath: string): Project {
    const tsConfigPath = path.join(localPath, 'tsconfig.json');

    if (fs.existsSync(tsConfigPath)) {
      return new Project({
        tsConfigFilePath: tsConfigPath,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true, jsx: 4 },
      });
    }

    return new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, jsx: 4 },
    });
  }

  // ---------- edge collection ----------

  private collectImports(
    sourceFile: SourceFile,
    localPath: string,
    fromId: string,
    edges: DependencyEdge[],
    externalDependencies: Record<string, string[]>,
  ) {
    for (const importDecl of sourceFile.getImportDeclarations()) {
      const resolved = importDecl.getModuleSpecifierSourceFile();
      const specifier = importDecl.getModuleSpecifierValue();

      if (resolved) {
        edges.push({
          from: fromId,
          to: this.toRelativeId(localPath, resolved.getFilePath()),
          kind: 'import',
          isTypeOnly: importDecl.isTypeOnly(),
        });
      } else if (this.isExternalPackage(specifier)) {
        externalDependencies[fromId].push(specifier);
      }
    }
  }

  private collectReExports(
    sourceFile: SourceFile,
    localPath: string,
    fromId: string,
    edges: DependencyEdge[],
    externalDependencies: Record<string, string[]>,
  ) {
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      if (!exportDecl.hasModuleSpecifier()) continue;

      const resolved = exportDecl.getModuleSpecifierSourceFile();
      const specifier = exportDecl.getModuleSpecifierValue();

      if (resolved) {
        edges.push({
          from: fromId,
          to: this.toRelativeId(localPath, resolved.getFilePath()),
          kind: 're-export',
          isTypeOnly: exportDecl.isTypeOnly(),
        });
      } else if (this.isExternalPackage(specifier)) {
        externalDependencies[fromId].push(specifier as string);
      }
    }
  }

  // ---------- graph analysis ----------

  /**
   * Tarjan's SCC algorithm — a strongly connected component with more
   * than one node means those files import each other in a cycle.
   * Recursive; fine for typical repos, but a very deep single import
   * chain (thousands of files in one path) could hit the call stack —
   * convert to an explicit stack if that ever becomes a problem.
   */
  private countCircularDependencies(graph: DependencyGraph): number {
    const adjacency = new Map<string, string[]>();
    graph.nodes.forEach((n) => adjacency.set(n, []));
    graph.edges.forEach((e) => adjacency.get(e.from)?.push(e.to));

    let index = 0;
    const indices = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let sccCount = 0;

    const strongConnect = (v: string) => {
      indices.set(v, index);
      lowlink.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of adjacency.get(v) ?? []) {
        if (!indices.has(w)) {
          strongConnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
        }
      }

      if (lowlink.get(v) === indices.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);

        if (component.length > 1) sccCount++;
      }
    };

    for (const node of graph.nodes) {
      if (!indices.has(node)) strongConnect(node);
    }

    return sccCount;
  }

  /**
   * BFS depth (shortest distance) from every "entry" file — a node with
   * no incoming internal edges — to the farthest file it reaches.
   * BFS instead of longest-simple-path because the latter is NP-hard
   * and the graph can contain cycles.
   */
  private computeMaxDepth(graph: DependencyGraph): number {
    const adjacency = new Map<string, string[]>();
    const hasIncoming = new Set<string>();
    graph.nodes.forEach((n) => adjacency.set(n, []));
    graph.edges.forEach((e) => {
      adjacency.get(e.from)?.push(e.to);
      hasIncoming.add(e.to);
    });

    const entryNodes = graph.nodes.filter((n) => !hasIncoming.has(n));
    const roots = entryNodes.length > 0 ? entryNodes : graph.nodes.slice(0, 1);

    let maxDepth = 0;
    const globalVisited = new Set<string>();

    for (const root of roots) {
      if (globalVisited.has(root)) continue;

      const queue: Array<{ node: string; depth: number }> = [{ node: root, depth: 0 }];
      const visited = new Set<string>([root]);

      while (queue.length) {
        const { node, depth } = queue.shift()!;
        maxDepth = Math.max(maxDepth, depth);
        globalVisited.add(node);

        for (const next of adjacency.get(node) ?? []) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push({ node: next, depth: depth + 1 });
          }
        }
      }
    }

    return maxDepth;
  }

  // ---------- helpers ----------

  private isExternalPackage(specifier: string | undefined): boolean {
    if (!specifier) return false;
    return !specifier.startsWith('.') && !specifier.startsWith('/');
  }

  private toRelativeId(localPath: string, absolutePath: string): string {
    return path.relative(localPath, absolutePath).split(path.sep).join('/');
  }
}