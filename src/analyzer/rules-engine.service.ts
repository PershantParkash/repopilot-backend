import { Injectable } from '@nestjs/common';
import { Project } from 'ts-morph';
import * as path from 'path';
import { RuleResult } from './rules/rule.types';
import { findComponents, toRelativeId } from './rules/ast-utils';
import { checkFileRules, checkComponentRules } from './rules/file-component-rules';
import { checkReactAndHookRules } from './rules/react-hooks-rules';
import { checkPerformanceRules, checkNextjsFileRules, checkNextConventionRules } from './rules/performance-nextjs-rules';
import { checkTypescriptRules, checkStateRules, checkApiRules } from './rules/typescript-state-api-rules';
import { checkCodeSmellRules } from './rules/code-smell-rules';
import { checkArchitectureAndDependencyRules, PerFileStats } from './rules/architecture-dependency-rules';
import { DependencyGraph } from './dependency-graph.service';

const IGNORE_GLOBS = [
  '**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**',
  '**/.turbo/**', '**/.vercel/**', '**/coverage/**', '**/*.d.ts',
];

@Injectable()
export class RulesEngineService {
  run(localPath: string, graph: DependencyGraph): RuleResult[] {
    const results: RuleResult[] = [];
    const perFile = new Map<string, PerFileStats>();

    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, jsx: 4 },
    });
    project.addSourceFilesAtPaths([
      path.join(localPath, '**/*.{ts,tsx,js,jsx}'),
      ...IGNORE_GLOBS.map((g) => `!${path.join(localPath, g)}`),
    ]);

    const clientFiles: string[] = [];
    let tsxCount = 0;
    let circularCount = 0; // computed by DependencyGraphService.summarize() upstream — pass in if you want it here

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = toRelativeId(localPath, sourceFile.getFilePath(), path.sep);
      const components = findComponents(sourceFile);

      results.push(...checkFileRules(sourceFile, filePath));
      results.push(...checkComponentRules(components, filePath));
      results.push(...checkReactAndHookRules(sourceFile, filePath, components));
      results.push(...checkPerformanceRules(sourceFile, filePath));
      results.push(...checkNextjsFileRules(sourceFile, filePath));
      results.push(...checkTypescriptRules(sourceFile, filePath));
      results.push(...checkStateRules(sourceFile, filePath));
      results.push(...checkApiRules(sourceFile, filePath, components));
      results.push(...checkCodeSmellRules(sourceFile, filePath));

      const maxComponentLoc = components.reduce((max, c) => {
        const loc = c.node.getEndLineNumber() - c.node.getStartLineNumber() + 1;
        return Math.max(max, loc);
      }, 0);

      perFile.set(filePath, {
        loc: sourceFile.getEndLineNumber(),
        imports: sourceFile.getImportDeclarations().length,
        exports: sourceFile.getExportedDeclarations().size,
        maxComponentLoc,
      });

      if (/^\s*['"]use client['"]/.test(sourceFile.getFullText())) clientFiles.push(filePath);
      if (filePath.endsWith('.tsx')) tsxCount++;
    }

    results.push(...checkArchitectureAndDependencyRules(graph, perFile, circularCount));
    results.push(...checkNextConventionRules(localPath));

    if (tsxCount > 0 && clientFiles.length / tsxCount > 0.8) {
      results.push({
        id: 'use-client-abuse', category: 'nextjs', severity: 'high',
        title: "Excessive 'use client' usage",
        description: `${clientFiles.length} of ${tsxCount} .tsx files (${Math.round((clientFiles.length / tsxCount) * 100)}%) are Client Components.`,
        file: 'repo',
        metric: { actual: Math.round((clientFiles.length / tsxCount) * 100), threshold: 80, unit: 'percent' },
        recommendation: 'Push "use client" down to leaf components; keep layouts/pages as Server Components where possible.',
      });
    }

    return results;
  }
}