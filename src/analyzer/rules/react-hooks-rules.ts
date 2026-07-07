import { Node, SourceFile, SyntaxKind } from 'ts-morph';
import { RuleResult, finding } from './rule.types';
import {
  ComponentInfo, ComponentLikeNode, getCallName, getLoc,
  isHookCallName, countIdentifierUses, findCustomHooks,
} from './ast-utils';

export function checkReactAndHookRules(
  sourceFile: SourceFile, filePath: string, components: ComponentInfo[],
): RuleResult[] {
  const results: RuleResult[] = [];
  const customHooks = findCustomHooks(sourceFile);
  const scopes = [
    ...components.map((c) => ({ ...c, isComponent: true })),
    ...customHooks.map((c) => ({ ...c, isComponent: false })),
  ];

  for (const { name, node, isComponent } of scopes) {
    const line = node.getStartLineNumber();

    if (!isComponent) {
      const loc = getLoc(node);
      if (loc > 250) {
        results.push(finding({
          id: 'custom-hook-too-big', category: 'hooks', severity: 'high',
          title: `Custom hook too big: ${name}`, description: `${name} spans ${loc} lines.`,
          line, metric: { actual: loc, threshold: 250, unit: 'lines' },
          recommendation: 'Split into smaller, composable hooks.',
        }, filePath));
      }
      node.forEachDescendant((d) => {
        if (Node.isReturnStatement(d)) {
          const expr = d.getExpression();
          if (expr && Node.isObjectLiteralExpression(expr) && expr.getProperties().length > 12) {
            results.push(finding({
              id: 'hook-returns-too-much', category: 'hooks', severity: 'medium',
              title: `Hook returns too much: ${name}`,
              description: `Returns an object with ${expr.getProperties().length} fields.`,
              line: d.getStartLineNumber(),
              metric: { actual: expr.getProperties().length, threshold: 12, unit: 'count' },
              recommendation: 'Split the hook, or group related values into sub-objects.',
            }, filePath));
          }
        }
      });
    }

    let useStateCount = 0;
    let useEffectCount = 0;

    node.forEachDescendant((child) => {
      // skip calls that belong to a nested function scope (handled in its own iteration)
      const nestedScope = child.getFirstAncestor(
        (a): a is ComponentLikeNode =>
          a !== node && (Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a)),
      );
      if (nestedScope) return;
      if (!Node.isCallExpression(child)) return;

      const callName = getCallName(child);
      if (!callName) return;

      if (callName === 'useState') {
        useStateCount++;
        checkStateDeclaration(child, node, filePath, results);
      }
      if (callName === 'useEffect') {
        useEffectCount++;
        checkUseEffect(child, filePath, results);
      }
      if (callName === 'useRef') checkAssignedVarUsage(child, node, filePath, results, 'ref-never-used', 'useRef result');
      if (callName === 'useMemo') checkAssignedVarUsage(child, node, filePath, results, 'memo-never-used', 'useMemo result');
      if (callName === 'useCallback') checkAssignedVarUsage(child, node, filePath, results, 'callback-never-used', 'useCallback result');
      if (callName === 'memo' || callName === 'React.memo') checkUselessMemo(child, filePath, results);
    });

    if (useEffectCount > 5) {
      results.push(finding({
        id: 'too-many-useeffect', category: 'react', severity: 'medium',
        title: `Too many useEffect calls: ${name}`, description: `${useEffectCount} useEffect calls.`,
        line, metric: { actual: useEffectCount, threshold: 5, unit: 'hooks' },
        recommendation: 'Consolidate related effects or extract them into custom hooks.',
      }, filePath));
    }
    if (useStateCount > 12) {
      results.push(finding({
        id: 'too-many-usestate', category: 'react', severity: 'medium',
        title: `Too many useState calls: ${name}`, description: `${useStateCount} useState calls.`,
        line, metric: { actual: useStateCount, threshold: 12, unit: 'hooks' },
        recommendation: 'Consider useReducer, or group related state into one object.',
      }, filePath));
    }
    if (!isComponent && useStateCount > 10) {
      results.push(finding({
        id: 'hook-uses-too-many-states', category: 'hooks', severity: 'medium',
        title: `Hook uses too many states: ${name}`, description: `Manages ${useStateCount} state values.`,
        line, metric: { actual: useStateCount, threshold: 10, unit: 'hooks' },
        recommendation: 'Split the hook or consolidate related state.',
      }, filePath));
    }
  }

  checkHookPlacementViolations(sourceFile, filePath, results);

  // Suspicious key
  sourceFile.forEachDescendant((child) => {
    if (Node.isJsxAttribute(child) && child.getNameNode().getText() === 'key') {
      const init = child.getInitializer();
      if (init && /\b(index|idx)\b/.test(init.getText())) {
        results.push(finding({
          id: 'suspicious-key', category: 'react', severity: 'medium',
          title: 'Array index used as React key',
          description: 'Using the list index as a key can cause bugs when items are reordered, inserted, or removed.',
          line: child.getStartLineNumber(),
          recommendation: 'Use a stable, unique identifier from the item data instead.',
        }, filePath));
      }
    }
  });

  return results;
}

function checkUseEffect(effectCall: Node, filePath: string, results: RuleResult[]) {
  if (!Node.isCallExpression(effectCall)) return;
  const [callback, depsArg] = effectCall.getArguments();
  if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) return;

  if (callback.isAsync()) {
    results.push(finding({
      id: 'async-usefffect', category: 'api', severity: 'critical',
      title: 'Async function passed directly to useEffect',
      description: 'useEffect callbacks must not be async — React expects a cleanup function or undefined as the return value.',
      line: effectCall.getStartLineNumber(),
      recommendation: 'Define an async function inside the effect and invoke it there instead.',
    }, filePath));
  }

  let hasFetchOrAxios = false;
  callback.forEachDescendant((d) => {
    const callName = getCallName(d);
    if (callName === 'fetch' || (callName && callName.startsWith('axios'))) hasFetchOrAxios = true;
  });
  if (hasFetchOrAxios) {
    results.push(finding({
      id: 'useeffect-fetch', category: 'react', severity: 'low',
      title: 'Data fetching inside useEffect',
      description: 'This effect performs a network request directly in the component.',
      line: effectCall.getStartLineNumber(),
      recommendation: 'Move the request into a service function, or use React Query / SWR.',
    }, filePath));
  }

  if (depsArg && Node.isArrayLiteralExpression(depsArg) && depsArg.getElements().length === 0) {
    const enclosing = callback.getFirstAncestor(
      (a): a is any => Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a),
    );
    const outerNames = new Set<string>();
    if (enclosing) {
      enclosing.getParameters().forEach((p: any) => {
        const nameNode = p.getNameNode();
        if (Node.isObjectBindingPattern(nameNode)) nameNode.getElements().forEach((el: any) => outerNames.add(el.getName()));
        else outerNames.add(p.getName());
      });
    }
    let referencesOuterScope = false;
    callback.forEachDescendant((d) => {
      if (Node.isIdentifier(d) && outerNames.has(d.getText())) referencesOuterScope = true;
    });
    if (referencesOuterScope) {
      results.push(finding({
        id: 'empty-dependency-array-abuse', category: 'react', severity: 'medium',
        title: 'Empty dependency array references outer values',
        description: 'This effect reads props from the enclosing scope but has an empty dependency array.',
        line: effectCall.getStartLineNumber(),
        recommendation: 'Add the referenced values to the dependency array or restructure the effect.',
      }, filePath));
    }
  }
}

function checkStateDeclaration(useStateCall: Node, scope: ComponentLikeNode, filePath: string, results: RuleResult[]) {
  const parent = useStateCall.getParent();
  if (!parent || !Node.isVariableDeclaration(parent)) return;
  const bindingName = parent.getNameNode();
  if (!Node.isArrayBindingPattern(bindingName)) return;

  const elements = bindingName.getElements();
  const stateEl = elements[0];
  const setterEl = elements[1];
  const stateName = stateEl && Node.isBindingElement(stateEl) ? stateEl.getName() : undefined;
  const setterName = setterEl && Node.isBindingElement(setterEl) ? setterEl.getName() : undefined;
  const line = parent.getStartLineNumber();

  const stateUses = stateName ? countIdentifierUses(scope, stateName, bindingName) : 0;
  const setterUses = setterName ? countIdentifierUses(scope, setterName, bindingName) : 0;

  if (stateName && stateUses === 0 && setterName && setterUses === 0) {
    results.push(finding({
      id: 'state-never-used', category: 'react', severity: 'low',
      title: `Unused state: ${stateName}`, description: `Neither ${stateName} nor ${setterName} is used after declaration.`,
      line, recommendation: 'Remove the dead state.',
    }, filePath));
    return;
  }
  if (stateName && stateUses === 0 && setterName && setterUses > 0) {
    results.push(finding({
      id: 'state-only-written', category: 'react', severity: 'medium',
      title: `State only written, never read: ${stateName}`,
      description: `${setterName} is called but ${stateName} is never read.`,
      line, recommendation: 'Remove the state if truly unused, or use it in the render/logic.',
    }, filePath));
  }
  if (setterName && setterUses === 0 && stateName && stateUses > 0) {
    results.push(finding({
      id: 'setter-never-used', category: 'react', severity: 'low',
      title: `Unused setter: ${setterName}`, description: `${setterName} is destructured but never called.`,
      line, recommendation: 'Remove the unused setter, or use a plain constant instead of useState.',
    }, filePath));
  }

  // Derived state: setter called with a binary expression combining other values
  scope.forEachDescendant((d) => {
    if (!setterName) return;
    if (Node.isCallExpression(d) && Node.isIdentifier(d.getExpression()) && d.getExpression().getText() === setterName) {
      const arg = d.getArguments()[0];
      if (arg && Node.isBinaryExpression(arg)) {
        results.push(finding({
          id: 'derived-state', category: 'react', severity: 'medium',
          title: `Derived state: ${stateName}`,
          description: `${setterName} is set from a computation of other values instead of being derived at render time.`,
          line: d.getStartLineNumber(),
          recommendation: `Compute this with useMemo (or inline) instead of storing it as separate state.`,
        }, filePath));
      }
    }
  });
}

function checkAssignedVarUsage(
  call: Node, scope: ComponentLikeNode, filePath: string, results: RuleResult[], ruleId: string, label: string,
) {
  const parent = call.getParent();
  if (!parent || !Node.isVariableDeclaration(parent)) return;
  const name = parent.getName();
  const uses = countIdentifierUses(scope, name, parent.getNameNode());
  if (uses === 0) {
    results.push(finding({
      id: ruleId, category: 'react', severity: 'low',
      title: `Unused ${label}: ${name}`, description: `${name} is declared but never referenced again.`,
      line: parent.getStartLineNumber(),
      recommendation: `Remove the unused ${label.split(' ')[0]}.`,
    }, filePath));
  }
}

function checkUselessMemo(call: Node, filePath: string, results: RuleResult[]) {
  if (!Node.isCallExpression(call)) return;
  const arg = call.getArguments()[0];
  if (!arg) return;
  let target: Node | undefined = arg;
  if (Node.isIdentifier(arg)) {
    // best-effort: can't always resolve; skip if we can't see the definition inline
    return;
  }
  if ((Node.isArrowFunction(target) || Node.isFunctionExpression(target)) && target.getParameters().length === 0) {
    results.push(finding({
      id: 'react-memo-useless', category: 'react', severity: 'info',
      title: 'React.memo on a component with no props',
      description: 'Memoizing a component that takes no props provides no benefit.',
      line: call.getStartLineNumber(),
      recommendation: 'Remove memo() unless props will be added later.',
    }, filePath));
  }
}

function checkHookPlacementViolations(sourceFile: SourceFile, filePath: string, results: RuleResult[]) {
  sourceFile.forEachDescendant((node) => {
    const callName = getCallName(node);
    if (!callName || !isHookCallName(callName)) return;

    const enclosing = node.getFirstAncestor(
      (a): a is ComponentLikeNode =>
        Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a),
    );
    if (!enclosing) return;

    // walk from the call up to `enclosing`, looking for loop/conditional ancestors
    let ancestor: Node | undefined = node.getParent();
    let inLoop = false;
    let inConditional = false;
    while (ancestor && ancestor !== enclosing) {
      if (Node.isForStatement(ancestor) || Node.isForInStatement(ancestor) || Node.isForOfStatement(ancestor) ||
          Node.isWhileStatement(ancestor) || Node.isDoStatement(ancestor)) inLoop = true;
      if (Node.isIfStatement(ancestor) || Node.isConditionalExpression(ancestor)) inConditional = true;
      ancestor = ancestor.getParent();
    }

    if (inLoop) {
      results.push(finding({
        id: 'hook-inside-loop', category: 'hooks', severity: 'critical',
        title: `Hook called inside a loop: ${callName}`,
        description: 'Hooks must be called in the same order on every render; calling them inside a loop breaks this.',
        line: node.getStartLineNumber(),
        recommendation: 'Move the hook call to the top level and loop over the data it returns instead.',
      }, filePath));
    } else if (inConditional) {
      results.push(finding({
        id: 'hook-calls-hook-conditionally', category: 'hooks', severity: 'critical',
        title: `Hook called conditionally: ${callName}`,
        description: 'Hooks must not be called conditionally — this breaks the Rules of Hooks.',
        line: node.getStartLineNumber(),
        recommendation: 'Call the hook unconditionally and branch on its return value instead.',
      }, filePath));
    }

    // Hook called inside a non-component, non-hook nested function
    const isComponentOrHook =
      (Node.isFunctionDeclaration(enclosing) && enclosing.getName() && /^[A-Z]|^use[A-Z]/.test(enclosing.getName()!)) ||
      (Node.isVariableDeclaration(enclosing.getParent()?.getParent() as any));
    const enclosingName =
      Node.isFunctionDeclaration(enclosing) ? enclosing.getName() :
      Node.isVariableDeclaration(enclosing.getParent()) ? (enclosing.getParent() as any).getName?.() : undefined;

    const outerScope = enclosing.getFirstAncestor(
      (a): a is ComponentLikeNode =>
        a !== enclosing && (Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a)),
    );
    if (outerScope && enclosingName && !/^(use[A-Z]|[A-Z])/.test(enclosingName)) {
      results.push(finding({
        id: 'hook-inside-function', category: 'hooks', severity: 'critical',
        title: `Hook called inside a plain nested function: ${enclosingName}`,
        description: `${callName} is called inside ${enclosingName}, which is neither a component nor a custom hook.`,
        line: node.getStartLineNumber(),
        recommendation: 'Call hooks only at the top level of a component or a custom hook (name it useXxx).',
      }, filePath));
    }
  });
}