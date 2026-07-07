import { RuleResult, finding } from './rule.types';
import { DependencyGraph } from '../dependency-graph.service';

export interface PerFileStats {
  loc: number;
  imports: number;
  exports: number;
  maxComponentLoc: number;
}

export function checkArchitectureAndDependencyRules(
  graph: DependencyGraph,
  perFile: Map<string, PerFileStats>,
  circularCount: number,
): RuleResult[] {
  const results: RuleResult[] = [];

  if (circularCount > 0) {
    results.push(finding({
      id: 'circular-dependency', category: 'architecture', severity: 'high',
      title: 'Circular dependencies detected',
      description: `${circularCount} circular import chain(s) found in the dependency graph.`,
      metric: { actual: circularCount, threshold: 0, unit: 'count' },
      recommendation: 'Break the cycle by extracting shared code into a lower-level module.',
    }, 'repo'));
  }

  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  graph.nodes.forEach((n) => { fanIn.set(n, 0); fanOut.set(n, 0); });
  graph.edges.forEach((e) => {
    fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
    fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
  });

  const externalPackages = new Set<string>();
  Object.values(graph.externalDependencies).forEach((pkgs) => pkgs.forEach((p) => externalPackages.add(p)));
  if (externalPackages.size > 80) {
    results.push(finding({
      id: 'package-explosion', category: 'architecture', severity: 'medium',
      title: 'Very large number of npm dependencies',
      description: `${externalPackages.size} distinct external packages imported.`,
      metric: { actual: externalPackages.size, threshold: 80, unit: 'count' },
      recommendation: 'Audit for redundant or unused packages.',
    }, 'repo'));
  }

  for (const node of graph.nodes) {
    const inCount = fanIn.get(node) ?? 0;
    const outCount = fanOut.get(node) ?? 0;
    const stats = perFile.get(node);

    if (inCount === 0 && outCount === 0) {
      results.push(finding({
        id: 'orphan-file', category: 'dependency', severity: 'low',
        title: 'Orphan file', description: 'No other file imports this, and it imports nothing internal.',
        recommendation: 'Verify this file is actually used, or remove it.',
      }, node));
    }
    if (inCount > 15) {
      results.push(finding({
        id: 'high-fan-in', category: 'dependency', severity: 'info',
        title: 'High fan-in (widely depended upon)', description: `${inCount} files import this one.`,
        metric: { actual: inCount, threshold: 15, unit: 'count' },
        recommendation: 'Keep this file stable — changes here have wide blast radius. Consider splitting if it mixes concerns.',
      }, node));
    }
    if (outCount > 20) {
      results.push(finding({
        id: 'high-fan-out', category: 'dependency', severity: 'medium',
        title: 'High fan-out (god component/module)', description: `Imports from ${outCount} other files.`,
        metric: { actual: outCount, threshold: 20, unit: 'imports' },
        recommendation: 'Split responsibilities; a file depending on this much is doing too much.',
      }, node));
    }
    if (inCount + outCount > 30) {
      results.push(finding({
        id: 'hub-node', category: 'dependency', severity: 'medium',
        title: 'Hub node in dependency graph', description: `Combined fan-in/fan-out of ${inCount + outCount}.`,
        metric: { actual: inCount + outCount, threshold: 30, unit: 'count' },
        recommendation: 'High-degree nodes are fragile change points — consider decoupling.',
      }, node));
    }

    if (stats) {
      if (stats.imports > 20 && stats.maxComponentLoc > 300) {
        results.push(finding({
          id: 'god-component', category: 'architecture', severity: 'high',
          title: 'God component', description: `${stats.imports} imports and a ${stats.maxComponentLoc}-line component.`,
          metric: { actual: stats.maxComponentLoc, threshold: 300, unit: 'lines' },
          recommendation: 'Split into smaller components and extract logic into hooks/services.',
        }, node));
      }
      if (/[\\/]services[\\/]/.test(node) && stats.exports > 25) {
        results.push(finding({
          id: 'god-service', category: 'architecture', severity: 'high',
          title: 'God service', description: `${stats.exports} exports from a single service module.`,
          metric: { actual: stats.exports, threshold: 25, unit: 'count' },
          recommendation: 'Split into multiple focused services.',
        }, node));
      }
      if (/utils?\.(ts|tsx|js|jsx)$/.test(node) && stats.loc > 500) {
        results.push(finding({
          id: 'utility-monster', category: 'architecture', severity: 'medium',
          title: 'Utility monster', description: `A generic utils file with ${stats.loc} lines.`,
          metric: { actual: stats.loc, threshold: 500, unit: 'lines' },
          recommendation: 'Split into domain-specific utility modules.',
        }, node));
      }
    }

    const topFoldersImported = new Set(
      graph.edges.filter((e) => e.from === node).map((e) => e.to.split('/')[0]),
    );
    if (topFoldersImported.size > 8) {
      results.push(finding({
        id: 'feature-coupling', category: 'architecture', severity: 'medium',
        title: 'High feature coupling', description: `Imports from ${topFoldersImported.size} different top-level folders.`,
        metric: { actual: topFoldersImported.size, threshold: 8, unit: 'count' },
        recommendation: 'Reduce cross-cutting imports; consider a shared/domain boundary.',
      }, node));
    }
  }

  return results;
}