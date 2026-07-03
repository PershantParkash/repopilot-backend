// analyzer/ast-analyzer.service.ts
import { Injectable } from '@nestjs/common';
import { Project, SourceFile, Node, CallExpression } from 'ts-morph';
import * as path from 'path';

// Glob patterns ts-morph understands directly (prefix with ! to exclude)
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

const BUILT_IN_HOOKS = new Set([
  'useState',
  'useEffect',
  'useContext',
  'useReducer',
  'useCallback',
  'useMemo',
  'useRef',
  'useLayoutEffect',
  'useImperativeHandle',
  'useDebugValue',
  'useTransition',
  'useDeferredValue',
  'useId',
  'useSyncExternalStore',
  'useInsertionEffect',
]);

export interface AstAnalysis {
  components: {
    total: number;
    names: string[];
  };
  hooks: {
    builtIn: Record<string, number>; // { useState: 12, useEffect: 5, ... }
    custom: { total: number; names: string[] };
  };
  contexts: {
    total: number;
    names: string[];
  };
  asyncFunctions: {
    total: number;
  };
  apiCalls: {
    fetch: number;
    axios: number;
    apiRoutes: string[]; // files matched as Next.js API routes
  };
  useEffectCount: number;
}

@Injectable()
export class AstAnalyzerService {
  analyze(localPath: string): AstAnalysis {
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: false,
      compilerOptions: {
        allowJs: true,
        jsx: 4, // JsxEmit.ReactJSX — lets the parser understand .tsx/.jsx syntax
      },
    });

    project.addSourceFilesAtPaths([
      path.join(localPath, '**/*.{ts,tsx,js,jsx}'),
      ...IGNORE_GLOBS.map((g) => `!${path.join(localPath, g)}`),
    ]);

    const result: AstAnalysis = {
      components: { total: 0, names: [] },
      hooks: { builtIn: {}, custom: { total: 0, names: [] } },
      contexts: { total: 0, names: [] },
      asyncFunctions: { total: 0 },
      apiCalls: { fetch: 0, axios: 0, apiRoutes: [] },
      useEffectCount: 0,
    };

    for (const sourceFile of project.getSourceFiles()) {
      this.analyzeFile(sourceFile, result);
    }

    return result;
  }

  // ---------- per-file walk ----------

  private analyzeFile(sourceFile: SourceFile, result: AstAnalysis) {
    const filePath = sourceFile.getFilePath();

    if (this.isApiRoute(filePath)) {
      result.apiCalls.apiRoutes.push(filePath);
    }

    sourceFile.forEachDescendant((node) => {
      this.checkAsyncFunction(node, result);
      this.checkCallExpression(node, result);
      this.checkComponent(node, result);
    });
  }

  private isApiRoute(filePath: string): boolean {
    // pages/api/** (Pages Router) or app/**/route.ts (App Router)
    return (
      /[\\/]pages[\\/]api[\\/]/.test(filePath) ||
      /[\\/]app[\\/].*[\\/]route\.(ts|tsx|js|jsx)$/.test(filePath)
    );
  }

  // ---------- async functions ----------

  private checkAsyncFunction(node: Node, result: AstAnalysis) {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isMethodDeclaration(node)
    ) {
      if (node.isAsync()) {
        result.asyncFunctions.total++;
      }
    }
  }

  // ---------- hooks, contexts, fetch/axios ----------

  private checkCallExpression(node: Node, result: AstAnalysis) {
    if (!Node.isCallExpression(node)) return;

    const callName = this.getCallName(node);
    if (!callName) return;

    // Built-in React hooks
    if (BUILT_IN_HOOKS.has(callName)) {
      result.hooks.builtIn[callName] = (result.hooks.builtIn[callName] || 0) + 1;
      if (callName === 'useEffect') result.useEffectCount++;
      return; // a built-in hook call can't also be a custom hook or createContext
    }

    // Custom hooks: anything matching useXxx that isn't a built-in
    if (/^use[A-Z]/.test(callName)) {
      result.hooks.custom.total++;
      if (!result.hooks.custom.names.includes(callName)) {
        result.hooks.custom.names.push(callName);
      }
    }

    // React.createContext(...) or createContext(...)
    if (callName === 'createContext') {
      result.contexts.total++;
      const varName = this.getAssignedVariableName(node);
      if (varName) result.contexts.names.push(varName);
    }

    // fetch(...)
    if (callName === 'fetch') {
      result.apiCalls.fetch++;
    }

    // axios(...) or axios.get/post/put/delete/patch(...)
    if (/^axios(\.|$)/.test(callName)) {
      result.apiCalls.axios++;
    }
  }

  /**
   * Resolves what a CallExpression is actually calling:
   *  - useState(...)          -> "useState"
   *  - React.useState(...)    -> "useState"
   *  - axios.get(...)         -> "axios.get"
   */
  private getCallName(node: CallExpression): string | null {
    const expr = node.getExpression();

    if (Node.isIdentifier(expr)) {
      return expr.getText();
    }

    if (Node.isPropertyAccessExpression(expr)) {
      const propertyName = expr.getName();
      const objectText = expr.getExpression().getText();

      if (objectText === 'axios') return `axios.${propertyName}`;
      // React.useState / React.useEffect etc. -> normalize to bare hook name
      return propertyName;
    }

    return null;
  }

  private getAssignedVariableName(node: Node): string | null {
    const parent = node.getParent();
    if (parent && Node.isVariableDeclaration(parent)) {
      return parent.getName();
    }
    return null;
  }

  // ---------- components ----------

  private checkComponent(node: Node, result: AstAnalysis) {
    // function Foo() { return <div/> }
    if (Node.isFunctionDeclaration(node)) {
      const name = node.getName();
      if (name && /^[A-Z]/.test(name) && this.containsJsx(node)) {
        result.components.total++;
        result.components.names.push(name);
      }
      return;
    }

    // const Foo = () => <div/>   OR   const Foo = function () { return <div/> }
    if (Node.isVariableDeclaration(node)) {
      const name = node.getName();
      const initializer = node.getInitializer();
      if (
        name &&
        /^[A-Z]/.test(name) &&
        initializer &&
        (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) &&
        this.containsJsx(initializer)
      ) {
        result.components.total++;
        result.components.names.push(name);
      }
    }
  }

  private containsJsx(node: Node): boolean {
    let found = false;
    node.forEachDescendant((child, traversal) => {
      if (
        Node.isJsxElement(child) ||
        Node.isJsxSelfClosingElement(child) ||
        Node.isJsxFragment(child)
      ) {
        found = true;
        traversal.stop();
      }
    });
    return found;
  }
}