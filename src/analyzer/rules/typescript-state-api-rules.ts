import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import { RuleResult, finding } from './rule.types';
import { getCallName, ComponentInfo, containsJsx } from './ast-utils';

export function checkTypescriptRules(sourceFile: SourceFile, filePath: string): RuleResult[] {
  const results: RuleResult[] = [];

  let anyCount = 0;
  let assertionAbuseCount = 0;
  sourceFile.forEachDescendant((n) => {
    if (n.getKind() === SyntaxKind.AnyKeyword) anyCount++;
    if (Node.isAsExpression(n) && n.getTypeNode()?.getText() === 'any') assertionAbuseCount++;
  });
  if (anyCount > 0) {
    results.push(finding({
      id: 'any-type', category: 'typescript', severity: anyCount > 10 ? 'high' : 'medium',
      title: `Uses 'any' type (${anyCount}x)`,
      description: `'any' disables type checking for ${anyCount} usage(s) in this file.`,
      metric: { actual: anyCount, threshold: 1, unit: 'count' },
      recommendation: "Replace with 'unknown' plus a type guard, or a precise type.",
    }, filePath));
  }
  if (assertionAbuseCount > 5) {
    results.push(finding({
      id: 'type-assertion-abuse', category: 'typescript', severity: 'high',
      title: "Excessive 'as any' assertions",
      description: `'as any' used ${assertionAbuseCount} times, bypassing the type system.`,
      metric: { actual: assertionAbuseCount, threshold: 5, unit: 'count' },
      recommendation: 'Fix the underlying type mismatches instead of asserting them away.',
    }, filePath));
  }

  sourceFile.getInterfaces().forEach((i) => {
    const propCount = i.getProperties().length;
    if (propCount > 25) {
      results.push(finding({
        id: 'huge-interface', category: 'typescript', severity: 'medium',
        title: `Huge interface: ${i.getName()}`, description: `${propCount} properties.`,
        line: i.getStartLineNumber(), metric: { actual: propCount, threshold: 25, unit: 'count' },
        recommendation: 'Split into smaller, composable interfaces.',
      }, filePath));
    }
    const isUsed = sourceFile.getFullText().split(i.getName()).length - 1 > 1; // declaration + at least one use
    if (!isUsed && !i.isExported()) {
      results.push(finding({
        id: 'interface-never-used', category: 'typescript', severity: 'low',
        title: `Unused interface: ${i.getName()}`, description: 'Declared but never referenced in this file.',
        line: i.getStartLineNumber(), recommendation: 'Remove it, or export it if used elsewhere.',
      }, filePath));
    }
  });

  sourceFile.getEnums().forEach((e) => {
    const isUsed = sourceFile.getFullText().split(e.getName()).length - 1 > 1;
    if (!isUsed && !e.isExported()) {
      results.push(finding({
        id: 'enum-never-used', category: 'typescript', severity: 'low',
        title: `Unused enum: ${e.getName()}`, description: 'Declared but never referenced in this file.',
        line: e.getStartLineNumber(), recommendation: 'Remove it, or export it if used elsewhere.',
      }, filePath));
    }
  });

  return results;
}

export function checkStateRules(sourceFile: SourceFile, filePath: string): RuleResult[] {
  const results: RuleResult[] = [];
  const isSlice = /\.slice\.(ts|tsx)$/.test(filePath) || sourceFile.getFullText().includes('createSlice');
  if (!isSlice) return results;

  const loc = sourceFile.getEndLineNumber();
  if (loc > 300) {
    results.push(finding({
      id: 'slice-too-big', category: 'state', severity: 'high',
      title: 'Redux slice too big', description: `Slice file is ${loc} lines.`,
      metric: { actual: loc, threshold: 300, unit: 'lines' },
      recommendation: 'Split into multiple slices by sub-domain.',
    }, filePath));
  }

  sourceFile.forEachDescendant((n) => {
    if (getCallName(n) === 'createSlice' && Node.isCallExpression(n)) {
      const config = n.getArguments()[0];
      if (config && Node.isObjectLiteralExpression(config)) {
        const reducersProp = config.getProperty('reducers');
        if (reducersProp && Node.isPropertyAssignment(reducersProp)) {
          const init = reducersProp.getInitializer();
          if (init && Node.isObjectLiteralExpression(init) && init.getProperties().length > 20) {
            results.push(finding({
              id: 'too-many-reducers', category: 'state', severity: 'medium',
              title: 'Too many reducers in one slice',
              description: `${init.getProperties().length} reducer cases in this slice.`,
              line: reducersProp.getStartLineNumber(),
              metric: { actual: init.getProperties().length, threshold: 20, unit: 'count' },
              recommendation: 'Split responsibilities into separate slices.',
            }, filePath));
          }
        }
      }
    }
  });

  return results;
}

export function checkApiRules(sourceFile: SourceFile, filePath: string, components: ComponentInfo[]): RuleResult[] {
  const results: RuleResult[] = [];
  const isServiceFile = /[\\/](services|api|lib)[\\/]/.test(filePath);

  for (const { name, node } of components) {
    let sequentialAwaits = 0;
    node.forEachDescendant((child) => {
      const callName = getCallName(child);
      const isFetchLike = callName === 'fetch' || (callName && callName.startsWith('axios'));
      if (!isFetchLike) return;

      // API call inside component body, outside of any hook/handler-nested-in-effect check is left to useeffect-fetch;
      // here we flag calls sitting directly in the top-level render body (not inside a function).
      const insideNestedFn = child.getFirstAncestor(
        (a) => a !== node && (Node.isArrowFunction(a) || Node.isFunctionExpression(a) || Node.isFunctionDeclaration(a)),
      );
      if (!insideNestedFn) {
        results.push(finding({
          id: 'api-in-render', category: 'api', severity: 'critical',
          title: `API call directly in render: ${name}`,
          description: 'A network call executes on every render, with no effect or handler boundary.',
          line: child.getStartLineNumber(),
          recommendation: 'Move this into useEffect, a handler, or a data-fetching hook.',
        }, filePath));
      } else if (!isServiceFile) {
        results.push(finding({
          id: 'api-call-inside-component', category: 'api', severity: 'info',
          title: `API call inside component: ${name}`,
          description: 'Network logic lives directly in the component instead of a service module.',
          line: child.getStartLineNumber(),
          recommendation: 'Extract this call into a services/ function and call that from the component.',
        }, filePath));
      }

      const awaitAncestor = child.getFirstAncestor((a) => Node.isAwaitExpression(a));
      if (awaitAncestor) {
        const tryAncestor = awaitAncestor.getFirstAncestor((a) => Node.isTryStatement(a));
        if (!tryAncestor) {
          results.push(finding({
            id: 'missing-error-handling', category: 'api', severity: 'medium',
            title: 'await without try/catch',
            description: 'A failed request here will throw unhandled.',
            line: awaitAncestor.getStartLineNumber(),
            recommendation: 'Wrap in try/catch, or handle rejection explicitly.',
          }, filePath));
        }
      }
    });

    node.forEachDescendant((block) => {
      if (Node.isBlock(block)) {
        const stmts = block.getStatements();
        let run = 0;
        for (const stmt of stmts) {
          const hasAwait = stmt.getDescendantsOfKind(SyntaxKind.AwaitExpression).length > 0;
          if (hasAwait) run++; else run = 0;
          if (run === 2) {
            sequentialAwaits++;
          }
        }
      }
    });
    if (sequentialAwaits > 0) {
      results.push(finding({
        id: 'sequential-await', category: 'api', severity: 'low',
        title: `Sequential independent awaits: ${name}`,
        description: 'Multiple await statements run one after another where they could run concurrently.',
        line: node.getStartLineNumber(),
        recommendation: 'Use Promise.all() if the calls do not depend on each other.',
      }, filePath));
    }
  }

  return results;
}