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
  from: string; // relative file path, e.g. "src/components/Dashboard.tsx"
  to: string; // relative file path, e.g. "src/components/UserCard.tsx"
  kind: 'import' | 're-export';
  isTypeOnly: boolean;
}

export interface DependencyGraph {
  nodes: string[]; // every internal file in the project, as relative paths
  edges: DependencyEdge[]; // internal file -> internal file dependency
  externalDependencies: Record<string, string[]>; // relative path -> npm package names it imports
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

  // ---------- project setup ----------

  /**
   * Loading the real tsconfig.json (when the repo has one) is what lets
   * ts-morph resolve path aliases like "@/components/Avatar" to a real
   * file. Without it, only relative imports ("./Avatar") would resolve.
   */
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
      // else: relative import that didn't resolve to a file we scanned
      // (e.g. broken import, or path outside localPath) — skipped silently
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
      if (!exportDecl.hasModuleSpecifier()) continue; // local `export { X }`, not a dependency

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

  // ---------- helpers ----------

  private isExternalPackage(specifier: string | undefined): boolean {
    if (!specifier) return false;
    // relative ("./x", "../x") or absolute ("/x") paths are internal;
    // everything else ("react", "@/lib/utils" pre-alias-resolution, "axios") is external
    return !specifier.startsWith('.') && !specifier.startsWith('/');
  }

  private toRelativeId(localPath: string, absolutePath: string): string {
    return path.relative(localPath, absolutePath).split(path.sep).join('/');
  }
}