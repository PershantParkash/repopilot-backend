import { Node, SourceFile } from 'ts-morph';
import { RuleResult, finding } from './rule.types';
import { ComponentInfo, findComponents, getLoc, containsJsx } from './ast-utils';

export function checkFileRules(sourceFile: SourceFile, filePath: string): RuleResult[] {
  const results: RuleResult[] = [];
  const loc = sourceFile.getEndLineNumber();

  if (loc > 700) {
    results.push(finding({
      id: 'very-large-file', category: 'file', severity: 'critical',
      title: 'Very large file', description: `File has ${loc} lines.`,
      metric: { actual: loc, threshold: 700, unit: 'lines' },
      recommendation: 'Split into smaller, single-purpose modules.',
    }, filePath));
  } else if (loc > 400) {
    results.push(finding({
      id: 'large-file', category: 'file', severity: 'high',
      title: 'Large file', description: `File has ${loc} lines.`,
      metric: { actual: loc, threshold: 400, unit: 'lines' },
      recommendation: 'Consider splitting this file into smaller modules.',
    }, filePath));
  }

  const exportsCount = sourceFile.getExportedDeclarations().size;
  if (exportsCount === 0 && loc > 0) {
    results.push(finding({
      id: 'empty-file', category: 'file', severity: 'low',
      title: 'File has no exports',
      description: 'This file exports nothing and may be dead code.',
      recommendation: 'Remove the file if unused, or export what it defines.',
    }, filePath));
  }
  if (exportsCount > 10) {
    results.push(finding({
      id: 'too-many-exports', category: 'file', severity: 'medium',
      title: 'Too many exports', description: `File exports ${exportsCount} members.`,
      metric: { actual: exportsCount, threshold: 10, unit: 'count' },
      recommendation: 'Split into more focused modules.',
    }, filePath));
  }

  const components = findComponents(sourceFile);
  if (components.length > 2) {
    results.push(finding({
      id: 'multiple-components', category: 'file', severity: 'medium',
      title: 'Multiple components in one file',
      description: `${components.length} components declared here.`,
      metric: { actual: components.length, threshold: 2, unit: 'count' },
      recommendation: 'Move each component into its own file.',
    }, filePath));
  }

  const hasHelperFn = sourceFile.getFunctions().some((f) => {
    const n = f.getName();
    return n && /^[a-z]/.test(n) && !containsJsx(f);
  });
  const hasTypes = sourceFile.getInterfaces().length > 0 || sourceFile.getTypeAliases().length > 0;
  const hasHooks = sourceFile.getVariableDeclarations().some((v) => /^use[A-Z]/.test(v.getName()));
  if ([components.length > 0, hasHelperFn, hasTypes, hasHooks].filter(Boolean).length >= 3) {
    results.push(finding({
      id: 'mixed-responsibility', category: 'file', severity: 'medium',
      title: 'Mixed responsibilities in one file',
      description: 'This file mixes components, helpers, types, and/or hooks.',
      recommendation: 'Separate components, hooks, types, and helpers into dedicated files.',
    }, filePath));
  }

  const depth = filePath.split('/').length - 1;
  if (depth > 7) {
    results.push(finding({
      id: 'deep-folder', category: 'file', severity: 'low',
      title: 'Deeply nested folder structure', description: `Nested ${depth} folders deep.`,
      metric: { actual: depth, threshold: 7, unit: 'depth' },
      recommendation: 'Flatten the folder structure or reorganize by feature.',
    }, filePath));
  }

  // Anonymous default-export component: `export default () => ...` / `export default function () {}`
  sourceFile.forEachDescendant((node) => {
    if (Node.isExportAssignment(node) && !node.isExportEquals()) {
      const expr = node.getExpression();
      if ((Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) && containsJsx(expr)) {
        results.push(finding({
          id: 'anonymous-component', category: 'component', severity: 'low',
          title: 'Anonymous default-exported component',
          description: 'Default export has no name, which hurts React DevTools traces and debugging.',
          line: node.getStartLineNumber(),
          recommendation: 'Name the component before exporting it: `function Foo() {}` then `export default Foo`.',
        }, filePath));
      }
    }
    if (Node.isFunctionDeclaration(node) && !node.getName() && containsJsx(node)) {
      results.push(finding({
        id: 'anonymous-component', category: 'component', severity: 'low',
        title: 'Anonymous default-exported component',
        description: 'Default export has no name, which hurts React DevTools traces and debugging.',
        line: node.getStartLineNumber(),
        recommendation: 'Name the component before exporting it.',
      }, filePath));
    }
  });

  return results;
}

export function checkComponentRules(components: ComponentInfo[], filePath: string): RuleResult[] {
  const results: RuleResult[] = [];

  for (const { name, node } of components) {
    const loc = getLoc(node);
    const line = node.getStartLineNumber();

    if (loc > 500) {
      results.push(finding({
        id: 'huge-component', category: 'component', severity: 'critical',
        title: `Huge component: ${name}`, description: `${name} spans ${loc} lines.`,
        line, metric: { actual: loc, threshold: 500, unit: 'lines' },
        recommendation: 'Break this component into smaller sub-components.',
      }, filePath));
    } else if (loc > 300) {
      results.push(finding({
        id: 'large-component', category: 'component', severity: 'high',
        title: `Large component: ${name}`, description: `${name} spans ${loc} lines.`,
        line, metric: { actual: loc, threshold: 300, unit: 'lines' },
        recommendation: 'Extract sub-components or hooks.',
      }, filePath));
    }

    // Huge JSX: the returned JSX block itself spans 100+ lines
    node.forEachDescendant((child) => {
      if (Node.isReturnStatement(child)) {
        const expr = child.getExpression();
        const jsxRoot = expr && Node.isParenthesizedExpression(expr) ? expr.getExpression() : expr;
        if (jsxRoot && (Node.isJsxElement(jsxRoot) || Node.isJsxFragment(jsxRoot))) {
          const jsxLoc = getLoc(jsxRoot);
          if (jsxLoc > 100) {
            results.push(finding({
              id: 'huge-jsx', category: 'component', severity: 'medium',
              title: `Huge JSX block: ${name}`, description: `Returned JSX spans ${jsxLoc} lines.`,
              line: jsxRoot.getStartLineNumber(),
              metric: { actual: jsxLoc, threshold: 100, unit: 'lines' },
              recommendation: 'Extract sections of this JSX into named sub-components.',
            }, filePath));
          }
        }
      }
    });

    // Too many props
    const params = node.getParameters();
    let propsCount = 0;
    if (params.length > 0) {
      const nameNode = params[0].getNameNode();
      propsCount = Node.isObjectBindingPattern(nameNode) ? nameNode.getElements().length : 1;
    }
    if (propsCount > 8) {
      results.push(finding({
        id: 'too-many-props', category: 'component', severity: 'medium',
        title: `Too many props: ${name}`, description: `${name} accepts ${propsCount} props.`,
        line, metric: { actual: propsCount, threshold: 8, unit: 'props' },
        recommendation: 'Group related props into an object, or split the component.',
      }, filePath));
    }

    // Too many JSX elements
    let jsxCount = 0;
    node.forEachDescendant((child) => {
      if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child) || Node.isJsxFragment(child)) jsxCount++;
    });
    if (jsxCount > 150) {
      results.push(finding({
        id: 'too-many-jsx-elements', category: 'component', severity: 'high',
        title: `Too many JSX elements: ${name}`, description: `Renders ${jsxCount} JSX nodes.`,
        line, metric: { actual: jsxCount, threshold: 150, unit: 'count' },
        recommendation: 'Break the render tree into smaller components.',
      }, filePath));
    }

    // Too many direct children
    node.forEachDescendant((child) => {
      if (Node.isJsxElement(child)) {
        const directChildren = child.getJsxChildren().filter(
          (c) => Node.isJsxElement(c) || Node.isJsxSelfClosingElement(c),
        ).length;
        if (directChildren > 20) {
          results.push(finding({
            id: 'too-many-children', category: 'component', severity: 'low',
            title: `Too many direct children: ${name}`,
            description: `A JSX element has ${directChildren} direct children.`,
            line: child.getStartLineNumber(),
            metric: { actual: directChildren, threshold: 20, unit: 'count' },
            recommendation: 'Group children into sub-components or map over structured data.',
          }, filePath));
        }
      }
    });

    // Conditional renders (&&, ternaries) + nested ternary depth
    let andCount = 0;
    let ternaryCount = 0;
    let maxTernaryNesting = 0;
    node.forEachDescendant((child) => {
      if (Node.isBinaryExpression(child) && child.getOperatorToken().getText() === '&&') andCount++;
      if (Node.isConditionalExpression(child)) {
        ternaryCount++;
        let depth = 1;
        let current: Node | undefined = child;
        while (true) {
          const parent: Node | undefined = current.getParent();
          if (!parent || parent === node) break;
          if (Node.isConditionalExpression(parent)) depth++;
          current = parent;
        }
        maxTernaryNesting = Math.max(maxTernaryNesting, depth);
      }
    });
    if (andCount > 10 || ternaryCount > 10) {
      results.push(finding({
        id: 'too-many-conditional-renders', category: 'component', severity: 'medium',
        title: `Too many conditional renders: ${name}`,
        description: `${andCount} '&&' guards and ${ternaryCount} ternaries in render logic.`,
        line, metric: { actual: Math.max(andCount, ternaryCount), threshold: 10, unit: 'count' },
        recommendation: 'Extract conditional branches into named sub-components.',
      }, filePath));
    }
    if (maxTernaryNesting > 3) {
      results.push(finding({
        id: 'nested-ternary', category: 'component', severity: 'high',
        title: `Deeply nested ternary: ${name}`,
        description: `Ternaries nested ${maxTernaryNesting} levels deep.`,
        line, metric: { actual: maxTernaryNesting, threshold: 3, unit: 'depth' },
        recommendation: 'Replace with if/else, early returns, or a lookup map.',
      }, filePath));
    }

    // Multiple returns
    let returnCount = 0;
    node.forEachDescendant((c) => { if (Node.isReturnStatement(c)) returnCount++; });
    if (returnCount > 5) {
      results.push(finding({
        id: 'multiple-returns', category: 'component', severity: 'low',
        title: `Many return statements: ${name}`, description: `${returnCount} return statements.`,
        line, metric: { actual: returnCount, threshold: 5, unit: 'count' },
        recommendation: 'Simplify branching or extract guard clauses into helpers.',
      }, filePath));
    }

    // Component-inside-component
    node.forEachDescendant((child) => {
      if (child === node) return;
      if (Node.isFunctionDeclaration(child)) {
        const cn = child.getName();
        if (cn && /^[A-Z]/.test(cn) && containsJsx(child)) {
          results.push(finding({
            id: 'component-inside-component', category: 'component', severity: 'high',
            title: `Component defined inside component: ${cn}`,
            description: `${cn} is nested inside ${name} and gets recreated every render.`,
            line: child.getStartLineNumber(),
            recommendation: `Move ${cn} outside of ${name}.`,
          }, filePath));
        }
      }
    });
  }

  return results;
}