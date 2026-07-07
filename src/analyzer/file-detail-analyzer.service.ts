// analyzer/file-detail-analyzer.service.ts
import { Injectable } from '@nestjs/common';
import { Project, SourceFile, Node, CallExpression, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import { RuleResult } from './rules/rule.types';
import { FileDetail, StateVar, EffectInfo, NetworkCall, RenderCalculation, FileKind } from './file-detail.types';
import * as fs from 'fs';



const BUILT_IN_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback', 'useMemo',
  'useRef', 'useLayoutEffect', 'useTransition', 'useDeferredValue', 'useId',
]);

const ARRAY_OPS = new Set(['filter', 'map', 'sort', 'reduce', 'flatMap', 'find']);

const IGNORE_GLOBS = [
  '**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**',
  '**/.turbo/**', '**/.vercel/**', '**/coverage/**', '**/*.d.ts',
];

const CONFIG_FILE_PATTERNS: RegExp[] = [
  /^babel\.config\./,
  /^webpack\.config\./,
  /^vite\.config\./,
  /^next\.config\./,
  /^jest\.config\./,
  /^tailwind\.config\./,
  /^postcss\.config\./,
  /^eslint\.config\./,
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^tsconfig.*\.json$/,
  /^jsconfig.*\.json$/,
  /^metro\.config\./,
  /^commitlint\.config\./,
  /^vitest\.config\./,
];

@Injectable()
export class FileDetailAnalyzerService {
  analyzeAll(localPath: string, allFindings: RuleResult[]): FileDetail[] {
    const isNextProject = this.detectNextProject(localPath);
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, jsx: 4 },
    });

    project.addSourceFilesAtPaths([
      path.join(localPath, '**/*.{ts,tsx,js,jsx}'),
      ...IGNORE_GLOBS.map((g) => `!${path.join(localPath, g)}`),
    ]);

    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const results: FileDetail[] = [];

    for (const sourceFile of project.getSourceFiles()) {
  const relativeFile = path.relative(localPath, sourceFile.getFilePath()).split(path.sep).join('/');

  if (this.isConfigFile(relativeFile)) continue; 

  const fileFindings = allFindings
    .filter((f) => f.file === relativeFile)
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  results.push(this.analyzeFile(sourceFile, relativeFile, fileFindings, isNextProject));
}

    return results;
  }

  groupByKind(details: FileDetail[]): Record<FileKind, FileDetail[]> {
  const grouped = {
    page: [],
    layout: [],
    component: [],
    hook: [],
    'api-route': [],
    other: [],
  } as Record<FileKind, FileDetail[]>;

  for (const detail of details) {
    grouped[detail.kind].push(detail);
  }

  return grouped;
}

  private detectNextProject(localPath: string): boolean {
  const pkgPath = path.join(localPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return Boolean(deps['next']);
  } catch {
    return false;
  }
}

private analyzeFile(
  sourceFile: SourceFile,
  relativeFile: string,
  findings: RuleResult[],
  isNextProject: boolean,
): FileDetail {
  const framework: 'react' | 'next' = isNextProject ? 'next' : 'react';
    const kind = this.detectKind(relativeFile, sourceFile.getFilePath());
    const useClientMatch = /^\s*['"]use client['"]/.test(sourceFile.getFullText());
    const useServerMatch = /^\s*['"]use server['"]/.test(sourceFile.getFullText());

    const detail: FileDetail = {
      file: relativeFile,
      framework,
      kind,
      summary: this.computeSummary(sourceFile),
      react: {
        hooks: { useState: 0, useEffect: 0, useMemo: 0, useCallback: 0, customHooks: [] },
        state: [],
        effects: [],
        render: {
          calculations: [],
          inlineFunctions: [],
          inlineObjects: 0,
          inlineArrays: 0,
          conditionalRendering: false,
          listRendering: [],
        },
        context: { consumes: [], provides: [] },
        memoization: { reactMemo: false, useMemo: false, useCallback: false },
      },
      browser: this.detectBrowserApis(sourceFile),
      network: { requests: [] },
      architecture: this.computeArchitecture(sourceFile),
      findings,
    };

    if (framework === 'next') {
      detail.runtime = {
        component: useClientMatch ? 'client' : 'server',
        reason: useClientMatch ? "use client directive" : 'no directive (defaults to Server Component)',
      };
      detail.next = this.computeNextInfo(sourceFile, relativeFile, useClientMatch, useServerMatch);
    }

    this.walkHooksAndCalls(sourceFile, detail);
    this.collectRenderPatterns(sourceFile, detail);
    this.collectContext(sourceFile, detail);

    detail.react.memoization.reactMemo = /\bmemo\s*\(/.test(sourceFile.getFullText());

    return detail;
  }

  // ---------- summary ----------

  private computeSummary(sourceFile: SourceFile) {
    const lines = sourceFile.getEndLineNumber();
    const imports = sourceFile.getImportDeclarations().length;
    const exports = sourceFile.getExportedDeclarations().size;

    let complexity = 1;
    sourceFile.forEachDescendant((node) => {
      if (
        Node.isIfStatement(node) || Node.isConditionalExpression(node) ||
        Node.isForStatement(node) || Node.isForInStatement(node) || Node.isForOfStatement(node) ||
        Node.isWhileStatement(node) || Node.isCaseClause(node) ||
        (Node.isBinaryExpression(node) && ['&&', '||'].includes(node.getOperatorToken().getText()))
      ) {
        complexity++;
      }
    });

    let jsxDepth = 0;
    const computeDepth = (node: Node, depth: number) => {
      if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node)) {
        jsxDepth = Math.max(jsxDepth, depth);
        node.forEachChild((c) => computeDepth(c, depth + 1));
        return;
      }
      node.forEachChild((c) => computeDepth(c, depth));
    };
    computeDepth(sourceFile, 0);

    return { lines, imports, exports, cyclomaticComplexity: complexity, jsxDepth };
  }

  // ---------- kind detection ----------

  private detectKind(relativeFile: string, absPath: string): FileKind {
    const base = path.basename(relativeFile).toLowerCase();
    if (/[\\/]pages[\\/]api[\\/]/.test(absPath) || /[\\/]app[\\/].*[\\/]route\.(ts|tsx|js|jsx)$/.test(absPath)) return 'api-route';
    if (base.startsWith('layout.')) return 'layout';
    if (base.startsWith('page.') || /[\\/]pages[\\/]/.test(absPath)) return 'page';
    if (/^use[A-Z]/.test(path.basename(relativeFile, path.extname(relativeFile)))) return 'hook';
    if (/\.(tsx|jsx)$/.test(relativeFile)) return 'component';
    return 'other';
  }

  // ---------- hooks, state, effects, network ----------

  private walkHooksAndCalls(sourceFile: SourceFile, detail: FileDetail) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const callName = this.getCallName(node);
      if (!callName) return;

      if (callName === 'useState') {
        detail.react.hooks.useState++;
        this.recordStateVar(node, sourceFile, detail);
        return;
      }
      if (callName === 'useEffect') {
        detail.react.hooks.useEffect++;
        detail.react.effects.push(this.buildEffectInfo(node, sourceFile));
        return;
      }
      if (callName === 'useMemo') {
        detail.react.hooks.useMemo++;
        detail.react.memoization.useMemo = true;
        return;
      }
      if (callName === 'useCallback') {
        detail.react.hooks.useCallback++;
        detail.react.memoization.useCallback = true;
        return;
      }
      if (/^use[A-Z]/.test(callName) && !BUILT_IN_HOOKS.has(callName)) {
        if (!detail.react.hooks.customHooks.includes(callName)) {
          detail.react.hooks.customHooks.push(callName);
        }
        return;
      }
      if (callName === 'fetch') {
        this.recordNetworkCall(node, sourceFile, detail, 'fetch');
      }
      if (/^axios(\.|$)/.test(callName)) {
        this.recordNetworkCall(node, sourceFile, detail, 'axios');
      }
    });
  }

  private recordStateVar(node: CallExpression, sourceFile: SourceFile, detail: FileDetail) {
    const decl = node.getParent();
    if (!decl || !Node.isVariableDeclaration(decl)) return;
    const nameNode = decl.getNameNode();
    if (!Node.isArrayBindingPattern(nameNode)) return;

    const elements = nameNode.getElements();
    const getterEl = elements[0];
    const setterEl = elements[1];
    if (!Node.isBindingElement(getterEl)) return;

    const name = getterEl.getName();
    const setterName = Node.isBindingElement(setterEl) ? setterEl.getName() : null;
    const initArg = node.getArguments()[0];

    const state: StateVar = {
      name,
      type: initArg ? this.inferSimpleType(initArg) : null,
      initializedWith: initArg ? initArg.getText() : null,
      writtenBy: setterName ? this.findWriters(sourceFile, setterName) : [],
      readBy: this.findReaders(sourceFile, name),
    };

    detail.react.state.push(state);
  }

  private findWriters(sourceFile: SourceFile, setterName: string): string[] {
    const contexts = new Set<string>();
    sourceFile.forEachDescendant((n) => {
      if (!Node.isCallExpression(n)) return;
      if (n.getExpression().getText() !== setterName) return;

      const effectAncestor = n.getFirstAncestor(
        (a) => Node.isCallExpression(a) && this.getCallName(a) === 'useEffect',
      );
      if (effectAncestor) { contexts.add('effect'); return; }

      const jsxAttr = n.getFirstAncestor((a) => Node.isJsxAttribute(a));
      if (jsxAttr && Node.isJsxAttribute(jsxAttr)) { contexts.add(jsxAttr.getNameNode().getText()); return; }

      const fn = n.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a));
      if (fn && Node.isFunctionDeclaration(fn) && fn.getName()) { contexts.add(fn.getName()!); return; }

      contexts.add('unknown');
    });
    return Array.from(contexts);
  }

  private findReaders(sourceFile: SourceFile, name: string): string[] {
    let usedInJsx = false;
    sourceFile.forEachDescendant((n) => {
      if (Node.isIdentifier(n) && n.getText() === name) {
        const inJsx = n.getFirstAncestor((a) => Node.isJsxElement(a) || Node.isJsxExpression(a) || Node.isJsxSelfClosingElement(a));
        if (inJsx) usedInJsx = true;
      }
    });
    return usedInJsx ? ['render'] : [];
  }

  private buildEffectInfo(node: CallExpression, sourceFile: SourceFile): EffectInfo {
    const [callback, depsArg] = node.getArguments();
    const dependencies: string[] = [];
    if (depsArg && Node.isArrayLiteralExpression(depsArg)) {
      depsArg.getElements().forEach((el) => dependencies.push(el.getText()));
    }

    const networkCalls: NetworkCall[] = [];
    const updatesState: string[] = [];
    let cleanup = false;

    if (callback) {
      callback.forEachDescendant((n) => {
        if (Node.isCallExpression(n)) {
          const cn = this.getCallName(n);
          if (cn === 'fetch') networkCalls.push(this.parseNetworkCall(n, 'fetch'));
          if (cn && /^axios(\.|$)/.test(cn)) networkCalls.push(this.parseNetworkCall(n, 'axios'));
          if (cn && /^set[A-Z]/.test(cn)) updatesState.push(cn.replace(/^set/, '').replace(/^./, (c) => c.toLowerCase()));
        }
        if (Node.isReturnStatement(n) && (Node.isArrowFunction(n.getParentIfKind?.(SyntaxKind.ArrowFunction) ?? n) )) {
          // best-effort: a return statement whose value is a function = cleanup
        }
      });
      if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
        const body = callback.getBody();
        if (Node.isBlock(body)) {
          cleanup = body.getStatements().some((s) => Node.isReturnStatement(s) && s.getExpression() !== undefined);
        }
      }
    }

    const purpose: EffectInfo['purpose'] = networkCalls.length > 0 ? 'data-fetch'
      : cleanup ? 'subscription'
      : /window|document|addEventListener/.test(callback?.getText() ?? '') ? 'dom'
      : 'unknown';

    return { purpose, dependencies, networkCalls, updatesState, cleanup };
  }

  private recordNetworkCall(node: CallExpression, sourceFile: SourceFile, detail: FileDetail, library: 'fetch' | 'axios') {
    const call = this.parseNetworkCall(node, library);
    const insideEffect = node.getFirstAncestor((a) => Node.isCallExpression(a) && this.getCallName(a) === 'useEffect');
    detail.network.requests.push({ ...call, inside: insideEffect ? 'useEffect' : 'render' });
  }

  private parseNetworkCall(node: CallExpression, library: 'fetch' | 'axios'): NetworkCall {
    const args = node.getArguments();
    const url = args[0] && Node.isStringLiteral(args[0]) ? args[0].getLiteralValue() : null;
    const callName = this.getCallName(node) ?? '';
    const method = library === 'axios' && callName.includes('.')
      ? callName.split('.')[1].toUpperCase()
      : 'GET';
    return { library, method, url };
  }

  private inferSimpleType(initArg: Node): string {
    if (Node.isArrayLiteralExpression(initArg)) return 'array';
    if (Node.isStringLiteral(initArg)) return 'string';
    if (Node.isNumericLiteral(initArg)) return 'number';
    if (initArg.getText() === 'true' || initArg.getText() === 'false') return 'boolean';
    if (Node.isObjectLiteralExpression(initArg)) return 'object';
    return 'unknown';
  }

  // ---------- render patterns ----------

  private collectRenderPatterns(sourceFile: SourceFile, detail: FileDetail) {
    sourceFile.forEachDescendant((node) => {
      if (Node.isVariableDeclaration(node)) {
        const init = node.getInitializer();
        if (init && Node.isCallExpression(init)) {
          const chain = this.extractCallChainOps(init);
          if (chain.length > 0) {
            detail.react.render.calculations.push({
              variable: node.getName(),
              operations: chain,
              dependsOn: [],
              estimatedCost: chain.length > 2 ? 'high' : 'medium',
              runsEveryRender: !node.getFirstAncestor((a) => Node.isCallExpression(a) && this.getCallName(a) === 'useMemo'),
            });
          }
        }
      }

      if (Node.isJsxAttribute(node)) {
        const init = node.getInitializer();
        if (init && Node.isJsxExpression(init)) {
          const expr = init.getExpression();
          if (expr && (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr))) {
            detail.react.render.inlineFunctions.push({ name: node.getNameNode().getText(), passedToChild: true });
          }
          if (expr && Node.isObjectLiteralExpression(expr)) detail.react.render.inlineObjects++;
          if (expr && Node.isArrayLiteralExpression(expr)) detail.react.render.inlineArrays++;
        }
      }

      if (Node.isConditionalExpression(node) || (Node.isBinaryExpression(node) && node.getOperatorToken().getText() === '&&')) {
        const hasJsxAncestorResult = node.getFirstAncestor((a) => Node.isJsxExpression(a));
        if (hasJsxAncestorResult) detail.react.render.conditionalRendering = true;
      }

      if (Node.isCallExpression(node) && this.getCallName(node) === 'map') {
        const jsxAncestor = node.getFirstAncestor((a) => Node.isJsxExpression(a));
        if (jsxAncestor) {
          const source = Node.isPropertyAccessExpression(node.getExpression())
            ? node.getExpression().getText().replace('.map', '')
            : 'unknown';
          const keyAttr = node.getArguments()[0];
          let key: string | null = null;
          if (keyAttr && (Node.isArrowFunction(keyAttr) || Node.isFunctionExpression(keyAttr))) {
            const body = keyAttr.getBody();
            const keyJsx = body.getDescendantsOfKind(SyntaxKind.JsxAttribute).find((a) => a.getNameNode().getText() === 'key');
            key = keyJsx ? keyJsx.getInitializer()?.getText() ?? null : null;
          }
          detail.react.render.listRendering.push({ source, key });
        }
      }
    });
  }

  private extractCallChainOps(node: CallExpression): string[] {
    const ops: string[] = [];
    let current: Node = node;
    while (Node.isCallExpression(current)) {
      const name = this.getCallName(current);
      if (name && ARRAY_OPS.has(name)) ops.unshift(name);
      const expr = current.getExpression();
      if (Node.isPropertyAccessExpression(expr)) current = expr.getExpression();
      else break;
    }
    return ops;
  }

  // ---------- context ----------

  private collectContext(sourceFile: SourceFile, detail: FileDetail) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const name = this.getCallName(node);
      if (name === 'useContext') {
        const arg = node.getArguments()[0];
        if (arg) detail.react.context.consumes.push(arg.getText());
      }
      if (name === 'createContext') {
        const decl = node.getParent();
        if (decl && Node.isVariableDeclaration(decl)) detail.react.context.provides.push(decl.getName());
      }
    });
  }

  private isConfigFile(relativeFile: string): boolean {
  const base = path.basename(relativeFile);
  return CONFIG_FILE_PATTERNS.some((p) => p.test(base));
}

  // ---------- next.js specifics ----------

  private computeNextInfo(sourceFile: SourceFile, relativeFile: string, useClient: boolean, useServer: boolean) {
    const text = sourceFile.getFullText();
    const base = path.basename(relativeFile).toLowerCase();

    return {
      page: base.startsWith('page.') || /[\\/]pages[\\/]/.test(relativeFile),
      layout: base.startsWith('layout.'),
      serverComponent: !useClient,
      clientComponent: useClient,
      serverActions: useServer ? ['use server'] : [],
      metadata: {
        generateMetadata: /export\s+(async\s+)?function\s+generateMetadata/.test(text),
        metadataExport: /export\s+const\s+metadata\s*=/.test(text),
      },
      dataFetching: {
        serverFetch: !useClient && /\bfetch\s*\(/.test(text),
        clientFetch: useClient && /\bfetch\s*\(/.test(text),
      },
      routing: {
        usesSearchParams: /useSearchParams\s*\(/.test(text),
        usesParams: /useParams\s*\(/.test(text),
        usesRouter: /useRouter\s*\(/.test(text),
      },
      cache: {
        revalidate: /export\s+const\s+revalidate\s*=/.test(text),
        cacheOption: (text.match(/cache:\s*['"](\w+)['"]/) ?? [])[1] ?? null,
      },
      assets: {
        nextImage: /from\s+['"]next\/image['"]/.test(text),
        nextFont: /from\s+['"]next\/font/.test(text),
      },
      specialFiles: {
        loading: base.startsWith('loading.'),
        error: base.startsWith('error.'),
      },
    };
  }

  // ---------- browser APIs ----------

  private detectBrowserApis(sourceFile: SourceFile) {
    const text = sourceFile.getFullText();
    return {
      window: /\bwindow\./.test(text),
      document: /\bdocument\./.test(text),
      localStorage: /\blocalStorage\./.test(text),
      sessionStorage: /\bsessionStorage\./.test(text),
      cookies: /\bdocument\.cookie\b/.test(text),
      navigator: /\bnavigator\./.test(text),
      clipboard: /\bnavigator\.clipboard\b/.test(text),
    };
  }

  // ---------- architecture ----------

  private computeArchitecture(sourceFile: SourceFile) {
    const buckets = { components: 0, hooks: 0, services: 0, utils: 0, store: 0 };
    const imports = sourceFile.getImportDeclarations();

    for (const imp of imports) {
      const spec = imp.getModuleSpecifierValue();
      if (/\/components\//.test(spec) || /^\.\.?\/[A-Z]/.test(spec)) buckets.components++;
      else if (/\/hooks\//.test(spec) || /\/use[A-Z]/.test(spec)) buckets.hooks++;
      else if (/\/services\//.test(spec) || /\/api\//.test(spec)) buckets.services++;
      else if (/\/utils\//.test(spec) || /\/lib\//.test(spec)) buckets.utils++;
      else if (/\/store\//.test(spec) || /redux|zustand/.test(spec)) buckets.store++;
    }

    const exportedDecls = sourceFile.getExportedDeclarations();
    const exportNames = Array.from(exportedDecls.keys());

    return { imports: buckets, dependencyCount: imports.length, exports: exportNames };
  }

  // ---------- shared helper ----------

  private getCallName(node: CallExpression): string | null {
    const expr = node.getExpression();
    if (Node.isIdentifier(expr)) return expr.getText();
    if (Node.isPropertyAccessExpression(expr)) {
      const propertyName = expr.getName();
      const objectText = expr.getExpression().getText();
      if (objectText === 'axios') return `axios.${propertyName}`;
      return propertyName;
    }
    return null;
  }
}