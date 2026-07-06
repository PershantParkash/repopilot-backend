// analyzer/analyzer.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AstAnalyzerService, AstAnalysis, ComponentInfo, HookUsage } from './ast-analyzer.service';
import {
  DependencyGraphService,
  DependencyGraph,
  DependencyGraphSummary,
} from './dependency-graph.service';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.vercel', 'coverage',
]);

interface ScanResult {
  files: number;
  folders: number;
  detectedFolders: string[];
}

interface DependencyFlags {
  typescript: boolean;
  nextjs: boolean;
  nextVersion: string | null;
  react: boolean;
  reactVersion: string | null;
  tailwind: boolean;
  redux: boolean;
  zustand: boolean;
  prisma: boolean;
  supabase: boolean;
  drizzle: boolean;
  reactQuery: boolean;
}

/** Everything we know — this is what gets persisted to the DB. */
export interface FullAnalysis {
  framework: { name: string; typescript: boolean; tailwind: boolean };
  files: number;
  folders: number;
  structure: string[];
  stateManagement: { redux: boolean; zustand: boolean };
  database: { prisma: boolean; supabase: boolean; drizzle: boolean };
  dataFetching: { reactQuery: boolean };
  ast: AstAnalysis;
  dependencyGraph: DependencyGraph;
  graphSummary: DependencyGraphSummary;
}

/** Lean, fixed-size response — this is what the API returns by default. */
export interface AnalysisSummary {
  framework: { name: string; typescript: boolean; tailwind: boolean };
  files: number;
  folders: number;
  structure: string[];
  stateManagement: { redux: boolean; zustand: boolean };
  database: { prisma: boolean; supabase: boolean; drizzle: boolean };
  dataFetching: { reactQuery: boolean };
  components: { total: number };
  hooks: {
    builtIn: Record<string, number>;
    custom: { total: number; unique: number };
  };
  contexts: { total: number; names: string[] };
  asyncFunctions: { total: number };
  apiCalls: { fetch: number; axios: number; apiRoutesCount: number };
  useEffectCount: number;
  dependencyGraph: DependencyGraphSummary;
}

@Injectable()
export class AnalyzerService {
  private readonly WATCHED_FOLDERS = [
    'src', 'app', 'pages', 'components', 'hooks', 'services', 'lib', 'utils', 'api',
  ];

  constructor(
    private readonly astAnalyzer: AstAnalyzerService,
    private readonly dependencyGraph: DependencyGraphService,
  ) {}

  async analyze(localPath: string): Promise<FullAnalysis> {
    if (!fs.existsSync(localPath)) {
      throw new NotFoundException(`Local repo path not found: ${localPath}`);
    }

    const packageJson = this.readPackageJson(localPath);
    const deps = this.detectDependencies(packageJson);
    const scan = this.scanDirectory(localPath);
    const frameworkName = this.buildFrameworkLabel(deps);

    const ast = this.astAnalyzer.analyze(localPath);
    const graph = this.dependencyGraph.build(localPath);
    const graphSummary = this.dependencyGraph.summarize(graph);

    return {
      framework: {
        name: frameworkName,
        typescript: deps.typescript,
        tailwind: deps.tailwind,
      },
      files: scan.files,
      folders: scan.folders,
      structure: scan.detectedFolders,
      stateManagement: { redux: deps.redux, zustand: deps.zustand },
      database: { prisma: deps.prisma, supabase: deps.supabase, drizzle: deps.drizzle },
      dataFetching: { reactQuery: deps.reactQuery },
      ast,
      dependencyGraph: graph,
      graphSummary,
    };
  }

  /** Strips a FullAnalysis down to the shape the default API response returns. */
  toSummary(full: FullAnalysis): AnalysisSummary {
    return {
      framework: full.framework,
      files: full.files,
      folders: full.folders,
      structure: full.structure,
      stateManagement: full.stateManagement,
      database: full.database,
      dataFetching: full.dataFetching,
      components: { total: full.ast.components.total },
      hooks: {
        builtIn: full.ast.hooks.builtIn,
        custom: {
          total: full.ast.hooks.custom.total,
          unique: full.ast.hooks.custom.unique,
        },
      },
      contexts: full.ast.contexts,
      asyncFunctions: full.ast.asyncFunctions,
      apiCalls: {
        fetch: full.ast.apiCalls.fetch,
        axios: full.ast.apiCalls.axios,
        apiRoutesCount: full.ast.apiCalls.apiRoutes.length,
      },
      useEffectCount: full.ast.useEffectCount,
      dependencyGraph: full.graphSummary,
    };
  }

  // ---------- detail slices for the dedicated endpoints ----------

  getComponents(full: FullAnalysis): ComponentInfo[] {
    return full.ast.components.items;
  }

  getHooks(full: FullAnalysis): HookUsage[] {
    return full.ast.hooks.custom.items;
  }

  getGraph(full: FullAnalysis): DependencyGraph {
    return full.dependencyGraph;
  }

  // ---------- package.json reading ----------

  private readPackageJson(localPath: string): any {
    const pkgPath = path.join(localPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private detectDependencies(pkg: any): DependencyFlags {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const has = (name: string) => Boolean(deps[name]);

    return {
      typescript: has('typescript'),
      nextjs: has('next'),
      nextVersion: deps['next'] ?? null,
      react: has('react'),
      reactVersion: deps['react'] ?? null,
      tailwind: has('tailwindcss'),
      redux: has('redux') || has('@reduxjs/toolkit') || has('react-redux'),
      zustand: has('zustand'),
      prisma: has('prisma') || has('@prisma/client'),
      supabase: has('@supabase/supabase-js'),
      drizzle: has('drizzle-orm'),
      reactQuery: has('@tanstack/react-query') || has('react-query'),
    };
  }

  private buildFrameworkLabel(deps: DependencyFlags): string {
    if (deps.nextjs && deps.nextVersion) {
      const major = deps.nextVersion.replace(/[^\d.]/g, '').split('.')[0];
      return `next${major || ''}`;
    }
    if (deps.react) return 'react';
    return 'unknown';
  }

  private scanDirectory(rootPath: string): ScanResult {
    let files = 0;
    let folders = 0;
    const detectedFolders = new Set<string>();

    const walk = (currentPath: string) => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          folders++;
          if (this.WATCHED_FOLDERS.includes(entry.name.toLowerCase())) {
            detectedFolders.add(entry.name.toLowerCase());
          }
          walk(path.join(currentPath, entry.name));
        } else if (entry.isFile()) {
          files++;
        }
      }
    };

    walk(rootPath);
    return { files, folders, detectedFolders: Array.from(detectedFolders) };
  }
}