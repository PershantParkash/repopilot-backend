import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import { RuleResult, finding } from './rule.types';
import { getCallName, getLoc, cyclomaticComplexity, maxNestingDepth } from './ast-utils';

export function checkCodeSmellRules(sourceFile: SourceFile, filePath: string): RuleResult[] {
  const results: RuleResult[] = [];

  sourceFile.forEachDescendant((n) => {
    if (getCallName(n) === 'console.log') {
      results.push(finding({
        id: 'console-log', category: 'code-smell', severity: 'low',
        title: 'console.log left in code', description: 'Debug logging left in the codebase.',
        line: n.getStartLineNumber(), recommendation: 'Remove it or replace with a proper logger.',
      }, filePath));
    }
    if (Node.isDebuggerStatement(n)) {
      results.push(finding({
        id: 'debugger-statement', category: 'code-smell', severity: 'critical',
        title: 'debugger statement left in code', description: 'This halts execution in a debugger-attached browser.',
        line: n.getStartLineNumber(), recommendation: 'Remove before shipping.',
      }, filePath));
    }
    if (Node.isCatchClause(n) && n.getBlock().getStatements().length === 0) {
      results.push(finding({
        id: 'empty-catch', category: 'code-smell', severity: 'medium',
        title: 'Empty catch block', description: 'Errors here are silently swallowed.',
        line: n.getStartLineNumber(), recommendation: 'At minimum log the error, or handle it explicitly.',
      }, filePath));
    }
    if (Node.isNonNullExpression(n)) {
      let count = 0;
      let cur: Node | undefined = n;
      while (cur && Node.isNonNullExpression(cur)) { count++; cur = cur.getExpression(); }
      if (count > 1) {
        results.push(finding({
          id: 'non-null-assertion-abuse', category: 'code-smell', severity: 'medium',
          title: 'Stacked non-null assertions', description: `${count} chained '!' assertions.`,
          line: n.getStartLineNumber(), recommendation: 'Narrow the type properly instead of forcing it.',
        }, filePath));
      }
    }
    if (Node.isSwitchStatement(n) && n.getClauses().length > 15) {
      results.push(finding({
        id: 'switch-too-large', category: 'code-smell', severity: 'medium',
        title: 'Switch statement too large', description: `${n.getClauses().length} cases.`,
        line: n.getStartLineNumber(), metric: { actual: n.getClauses().length, threshold: 15, unit: 'count' },
        recommendation: 'Use a lookup table/map, or split by responsibility.',
      }, filePath));
    }
    if (Node.isObjectLiteralExpression(n) && n.getProperties().length > 50) {
      results.push(finding({
        id: 'giant-object-literal', category: 'code-smell', severity: 'medium',
        title: 'Giant object literal', description: `${n.getProperties().length} properties.`,
        line: n.getStartLineNumber(), metric: { actual: n.getProperties().length, threshold: 50, unit: 'count' },
        recommendation: 'Move to a config/constants file, or generate it.',
      }, filePath));
    }
    if (Node.isNumericLiteral(n)) {
      const text = n.getText();
      const parent = n.getParent();
      const inCondition = parent && (Node.isBinaryExpression(parent) || Node.isIfStatement(parent));
      if (inCondition && !['0', '1', '-1'].includes(text)) {
        results.push(finding({
          id: 'magic-numbers', category: 'code-smell', severity: 'info',
          title: `Magic number: ${text}`, description: 'An unexplained numeric literal used in a condition.',
          line: n.getStartLineNumber(), recommendation: 'Extract it into a named constant.',
        }, filePath));
      }
    }
  });

  // duplicate string literals
  const stringCounts = new Map<string, number>();
  sourceFile.forEachDescendant((n) => {
    if (Node.isStringLiteral(n) && n.getLiteralText().length > 2) {
      stringCounts.set(n.getLiteralText(), (stringCounts.get(n.getLiteralText()) ?? 0) + 1);
    }
  });
  for (const [str, count] of stringCounts) {
    if (count > 5) {
      results.push(finding({
        id: 'duplicate-string-literal', category: 'code-smell', severity: 'low',
        title: `Repeated string literal: "${str}"`, description: `Appears ${count} times in this file.`,
        metric: { actual: count, threshold: 5, unit: 'count' },
        recommendation: 'Extract into a shared constant.',
      }, filePath));
    }
  }

  // per-function checks: long function, cyclomatic complexity, nesting, param count, empty function/effect
  const fns: Node[] = [];
  sourceFile.forEachDescendant((n) => {
    if (Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isMethodDeclaration(n)) {
      fns.push(n);
    }
  });

  for (const fn of fns) {
    const anyFn = fn as any;
    const loc = getLoc(fn);
    const line = fn.getStartLineNumber();
    const label = anyFn.getName?.() ?? '(anonymous)';

    if (loc > 80) {
      results.push(finding({
        id: 'long-function', category: 'code-smell', severity: 'medium',
        title: `Long function: ${label}`, description: `${loc} lines.`,
        line, metric: { actual: loc, threshold: 80, unit: 'lines' },
        recommendation: 'Extract smaller, named helper functions.',
      }, filePath));
    }

    const complexity = cyclomaticComplexity(fn);
    if (complexity > 15) {
      results.push(finding({
        id: 'high-cyclomatic-complexity', category: 'code-smell', severity: 'high',
        title: `High cyclomatic complexity: ${label}`, description: `Complexity score of ${complexity}.`,
        line, metric: { actual: complexity, threshold: 15, unit: 'count' },
        recommendation: 'Simplify branching, extract sub-functions, or use early returns.',
      }, filePath));
    }

    const nesting = maxNestingDepth(fn);
    if (nesting > 5) {
      results.push(finding({
        id: 'deep-nesting', category: 'code-smell', severity: 'medium',
        title: `Deeply nested logic: ${label}`, description: `${nesting} levels of nested blocks.`,
        line, metric: { actual: nesting, threshold: 5, unit: 'depth' },
        recommendation: 'Use early returns/guard clauses to flatten the logic.',
      }, filePath));
    }

    const params = anyFn.getParameters ? anyFn.getParameters() : [];
    if (params.length > 6) {
      results.push(finding({
        id: 'long-parameter-list', category: 'code-smell', severity: 'low',
        title: `Long parameter list: ${label}`, description: `${params.length} parameters.`,
        line, metric: { actual: params.length, threshold: 6, unit: 'count' },
        recommendation: 'Bundle related parameters into a single options object.',
      }, filePath));
    }

    const body = anyFn.getBody?.();
    if (body && Node.isBlock(body) && body.getStatements().length === 0) {
      const isEffectCallback = fn.getParent() && Node.isCallExpression(fn.getParent()) && getCallName(fn.getParent()!) === 'useEffect';
      results.push(finding({
        id: isEffectCallback ? 'empty-usefffect' : 'empty-function', category: 'code-smell', severity: 'low',
        title: isEffectCallback ? 'Empty useEffect' : `Empty function: ${label}`,
        description: 'This function/effect body has no statements.',
        line, recommendation: 'Remove it, or implement the intended logic.',
      }, filePath));
    }
  }

  // floating promises: async call as a bare expression statement, not awaited/returned/.then/.catch'd
  sourceFile.forEachDescendant((n) => {
    if (Node.isExpressionStatement(n)) {
      const expr = n.getExpression();
      if (Node.isCallExpression(expr)) {
        const callName = getCallName(expr);
        const looksAsync = callName && /^(fetch|axios|save|update|delete|create|submit|post|get|patch|put)/i.test(callName);
        if (looksAsync) {
          results.push(finding({
            id: 'floating-promise', category: 'code-smell', severity: 'low',
            title: `Possible unhandled promise: ${callName}`,
            description: 'This call is not awaited and has no .then/.catch — errors may be silently dropped.',
            line: n.getStartLineNumber(),
            recommendation: 'Await it, chain .catch(), or explicitly mark it as intentionally fire-and-forget.',
          }, filePath));
        }
      }
    }
  });

  return results;
}