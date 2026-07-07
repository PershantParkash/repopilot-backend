import {
  Node, SourceFile, SyntaxKind,
  FunctionDeclaration, ArrowFunction, FunctionExpression,
} from 'ts-morph';

export const BUILT_IN_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle',
  'useDebugValue', 'useTransition', 'useDeferredValue', 'useId',
  'useSyncExternalStore', 'useInsertionEffect',
]);

export type ComponentLikeNode = FunctionDeclaration | ArrowFunction | FunctionExpression;

export interface ComponentInfo {
  name: string;
  node: ComponentLikeNode;
}

export function containsJsx(node: Node): boolean {
  let found = false;
  node.forEachDescendant((child, traversal) => {
    if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child) || Node.isJsxFragment(child)) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

export function getLoc(node: Node): number {
  return node.getEndLineNumber() - node.getStartLineNumber() + 1;
}

/** Top-level components: `function Foo()` or `const Foo = () => <jsx/>` returning JSX. */
export function findComponents(sourceFile: SourceFile): ComponentInfo[] {
  const components: ComponentInfo[] = [];

  sourceFile.forEachDescendant((node) => {
    if (Node.isFunctionDeclaration(node)) {
      const name = node.getName();
      if (name && /^[A-Z]/.test(name) && node.getBody() && containsJsx(node)) {
        components.push({ name, node });
      }
    }
    if (Node.isVariableDeclaration(node)) {
      const name = node.getName();
      const init = node.getInitializer();
      if (
        name && /^[A-Z]/.test(name) && init &&
        (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) &&
        containsJsx(init)
      ) {
        components.push({ name, node: init });
      }
    }
  });

  return components;
}

/** Custom hooks: `function useFoo()` / `const useFoo = () => {}`, NOT required to return JSX. */
export function findCustomHooks(sourceFile: SourceFile): ComponentInfo[] {
  const hooks: ComponentInfo[] = [];
  sourceFile.forEachDescendant((node) => {
    if (Node.isFunctionDeclaration(node)) {
      const name = node.getName();
      if (name && /^use[A-Z]/.test(name)) hooks.push({ name, node });
    }
    if (Node.isVariableDeclaration(node)) {
      const name = node.getName();
      const init = node.getInitializer();
      if (name && /^use[A-Z]/.test(name) && init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        hooks.push({ name, node: init });
      }
    }
  });
  return hooks;
}

export function getCallName(node: Node): string | null {
  if (!Node.isCallExpression(node)) return null;
  const expr = node.getExpression();
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) {
    const obj = expr.getExpression().getText();
    return obj === 'axios' ? `axios.${expr.getName()}` : expr.getName();
  }
  return null;
}

export function isHookCallName(name: string): boolean {
  return BUILT_IN_HOOKS.has(name) || /^use[A-Z]/.test(name);
}

export function getEnclosingFunction(node: Node): ComponentLikeNode | undefined {
  return node.getFirstAncestor(
    (a): a is ComponentLikeNode =>
      Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a),
  );
}

/** Counts identifier occurrences with this name anywhere under `scope`, minus the declaration itself. */
export function countIdentifierUses(scope: Node, name: string, excludeNode: Node): number {
  let count = 0;
  scope.forEachDescendant((d) => {
    if (d === excludeNode) return;
    if (Node.isIdentifier(d) && d.getText() === name) count++;
  });
  return count;
}

export function cyclomaticComplexity(node: Node): number {
  let complexity = 1;
  node.forEachDescendant((child) => {
    if (
      Node.isIfStatement(child) || Node.isForStatement(child) || Node.isForInStatement(child) ||
      Node.isForOfStatement(child) || Node.isWhileStatement(child) || Node.isDoStatement(child) ||
      Node.isCaseClause(child) || Node.isCatchClause(child) || Node.isConditionalExpression(child)
    ) {
      complexity++;
    }
    if (Node.isBinaryExpression(child)) {
      const op = child.getOperatorToken().getKind();
      if (op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken) complexity++;
    }
  });
  return complexity;
}

export function maxNestingDepth(node: Node): number {
  let max = 0;
  const walk = (n: Node, depth: number) => {
    let next = depth;
    if (
      Node.isIfStatement(n) || Node.isForStatement(n) || Node.isForInStatement(n) ||
      Node.isForOfStatement(n) || Node.isWhileStatement(n) || Node.isDoStatement(n) ||
      Node.isSwitchStatement(n) || Node.isTryStatement(n)
    ) {
      next = depth + 1;
      max = Math.max(max, next);
    }
    n.forEachChild((c) => walk(c, next));
  };
  walk(node, 0);
  return max;
}

export function toRelativeId(localPath: string, absolutePath: string, pathSep: string): string {
  return absolutePath.startsWith(localPath)
    ? absolutePath.slice(localPath.length + 1).split(pathSep).join('/')
    : absolutePath;
}