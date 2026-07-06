// analyzer/ast-analyzer.service.ts
import { Injectable } from '@nestjs/common';
import { Project, SourceFile, Node, CallExpression } from 'ts-morph';
import * as path from 'path';

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

export interface ComponentInfo {
  name: string;
  file: string;
}

export interface HookUsage {
  name: string;
  count: number;
}

export interface AstAnalysis {
  components: {
    total: number;
    items: ComponentInfo[]; // full detail — trimmed to {total} in the summary response
  };
  hooks: {
    builtIn: Record<string, number>; // small/fixed-size, safe to always inline
    custom: {
      total: number; // total call sites
      unique: number; // distinct hook names
      items: HookUsage[]; // full detail — trimmed to {total, unique} in the summary
    };
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
    apiRoutes: string[];
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
        jsx: 4, // JsxEmit.ReactJSX
      },
    });

    project.addSourceFilesAtPaths([
      path.join(localPath, '**/*.{ts,tsx,js,jsx}'),
      ...IGNORE_GLOBS.map((g) => `!${path.join(localPath, g)}`),
    ]);

    const result: AstAnalysis = {
      components: { total: 0, items: [] },
      hooks: { builtIn: {}, custom: { total: 0, unique: 0, items: [] } },
      contexts: { total: 0, names: [] },
      asyncFunctions: { total: 0 },
      apiCalls: { fetch: 0, axios: 0, apiRoutes: [] },
      useEffectCount: 0,
    };

    // name -> call count, kept outside `result` until we finalize the sorted list
    const customHookCounts = new Map<string, number>();

    for (const sourceFile of project.getSourceFiles()) {
      const relativeFile = this.toRelativeId(localPath, sourceFile.getFilePath());
      this.analyzeFile(sourceFile, relativeFile, result, customHookCounts);
    }

    result.hooks.custom.unique = customHookCounts.size;
    result.hooks.custom.items = Array.from(customHookCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count); // most-used hooks first

    return result;
  }

  // ---------- per-file walk ----------

  private analyzeFile(
    sourceFile: SourceFile,
    relativeFile: string,
    result: AstAnalysis,
    customHookCounts: Map<string, number>,
  ) {
    if (this.isApiRoute(sourceFile.getFilePath())) {
      result.apiCalls.apiRoutes.push(relativeFile);
    }

    sourceFile.forEachDescendant((node) => {
      this.checkAsyncFunction(node, result);
      this.checkCallExpression(node, result, customHookCounts);
      this.checkComponent(node, relativeFile, result);
    });
  }

  private isApiRoute(filePath: string): boolean {
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

  private checkCallExpression(
    node: Node,
    result: AstAnalysis,
    customHookCounts: Map<string, number>,
  ) {
    if (!Node.isCallExpression(node)) return;

    const callName = this.getCallName(node);
    if (!callName) return;

    if (BUILT_IN_HOOKS.has(callName)) {
      result.hooks.builtIn[callName] = (result.hooks.builtIn[callName] || 0) + 1;
      if (callName === 'useEffect') result.useEffectCount++;
      return;
    }

    if (/^use[A-Z]/.test(callName)) {
      result.hooks.custom.total++;
      customHookCounts.set(callName, (customHookCounts.get(callName) || 0) + 1);
    }

    if (callName === 'createContext') {
      result.contexts.total++;
      const varName = this.getAssignedVariableName(node);
      if (varName) result.contexts.names.push(varName);
    }

    if (callName === 'fetch') {
      result.apiCalls.fetch++;
    }

    if (/^axios(\.|$)/.test(callName)) {
      result.apiCalls.axios++;
    }
  }

  private getCallName(node: CallExpression): string | null {
    const expr = node.getExpression();

    if (Node.isIdentifier(expr)) {
      return expr.getText();
    }

    if (Node.isPropertyAccessExpression(expr)) {
      const propertyName = expr.getName();
      const objectText = expr.getExpression().getText();

      if (objectText === 'axios') return `axios.${propertyName}`;
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

  private checkComponent(node: Node, relativeFile: string, result: AstAnalysis) {
    if (Node.isFunctionDeclaration(node)) {
      const name = node.getName();
      if (name && /^[A-Z]/.test(name) && this.containsJsx(node)) {
        result.components.total++;
        result.components.items.push({ name, file: relativeFile });
      }
      return;
    }

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
        result.components.items.push({ name, file: relativeFile });
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

  // ---------- helpers ----------

  private toRelativeId(localPath: string, absolutePath: string): string {
    return path.relative(localPath, absolutePath).split(path.sep).join('/');
  }
}