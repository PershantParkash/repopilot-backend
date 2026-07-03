// analyzer/analyzer.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AstAnalyzerService } from './ast-analyzer.service';
import { DependencyGraphService } from './dependency-graph.service';

// Folders we never want to walk into
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.vercel',
  'coverage',
]);

interface ScanResult {
  files: number;
  folders: number;
  detectedFolders: string[]; // e.g. ['src', 'app', 'components']
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

@Injectable()
export class AnalyzerService {
  private readonly WATCHED_FOLDERS = [
    'src',
    'app',
    'pages',
    'components',
    'hooks',
    'services',
    'lib',
    'utils',
    'api',
  ];

   constructor(
    private readonly astAnalyzer: AstAnalyzerService,  
    private readonly dependencyGraph: DependencyGraphService,) {}

  async analyze(localPath: string) {
    if (!fs.existsSync(localPath)) {
      throw new NotFoundException(`Local repo path not found: ${localPath}`);
    }

    const packageJson = this.readPackageJson(localPath);
    const deps = this.detectDependencies(packageJson);
    const scan = this.scanDirectory(localPath);

    const framework = this.buildFrameworkLabel(deps);
    const ast = this.astAnalyzer.analyze(localPath);
    const dependencyGraph = this.dependencyGraph.build(localPath);
    return {
      framework,
      typescript: deps.typescript,
      tailwind: deps.tailwind,
      files: scan.files,
      folders: scan.folders,
      nextjs: deps.nextjs,
      react: deps.react,
      structure: scan.detectedFolders, 
      stateManagement: {
        redux: deps.redux,
        zustand: deps.zustand,
      },
      database: {
        prisma: deps.prisma,
        supabase: deps.supabase,
        drizzle: deps.drizzle,
      },
      dataFetching: {
        reactQuery: deps.reactQuery,
      },
      ast,
      dependencyGraph,
    };
  }

  // ---------- package.json reading ----------

  private readPackageJson(localPath: string): any {
    const pkgPath = path.join(localPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return {}; // not a JS/TS project, or package.json missing
    }
    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private detectDependencies(pkg: any): DependencyFlags {
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

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

          walk(path.join(currentPath, entry.name)); // recurse
        } else if (entry.isFile()) {
          files++;
        }
      }
    };

    walk(rootPath);

    return {
      files,
      folders,
      detectedFolders: Array.from(detectedFolders),
    };
  }
}