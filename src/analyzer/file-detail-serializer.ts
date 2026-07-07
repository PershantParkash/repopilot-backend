// analyzer/file-detail-serializer.ts
//
// Converts the full, internally-computed FileDetail into the lean shape an
// AI code reviewer actually needs. General rule applied throughout:
//
//   Do not serialize default values.
//   - drop false, 0, null, "", [], {}
//   - collapse boolean-flag objects (browser, memoization) into arrays of
//     the flags that are actually true
//   - drop the `react` block entirely for files with no React signal
//     (no hooks, no state, no effects, no JSX render patterns)
//
// This does NOT change FileDetailAnalyzerService or its output — it's a
// pure transform you call at the point you're about to hand data to the AI
// reviewer (e.g. in getFindings(), or a new getFindingsCompact()).

import {
  FileDetail,
  StateVar,
  EffectInfo,
  NetworkCall,
  RenderCalculation,
} from './file-detail.types';
import {
  CompactFileDetail,
  CompactStateVar,
  CompactEffectInfo,
  CompactNetworkCall,
  CompactRenderCalculation,
  CompactReact,
  CompactNext,
  BrowserApi,
  MemoizationFlag,
} from './file-detail-compact.types';

export function toCompactFileDetail(detail: FileDetail): CompactFileDetail {
  const compact: CompactFileDetail = {
    file: detail.file,
    kind: detail.kind,
    summary: {
      lines: detail.summary.lines,
      imports: detail.summary.imports,
      exports: detail.summary.exports,
      cyclomaticComplexity: detail.summary.cyclomaticComplexity,
      ...(detail.summary.jsxDepth ? { jsxDepth: detail.summary.jsxDepth } : {}),
    },
    architecture: {
      ...(hasAny(detail.architecture.imports)
        ? { imports: pruneZeroCounts(detail.architecture.imports) }
        : {}),
      dependencyCount: detail.architecture.dependencyCount,
      exports: detail.architecture.exports,
    },
    findings: detail.findings,
  };

  // framework: only worth stating when it deviates from the project default ('react')
  if (detail.framework === 'next') {
    compact.framework = detail.framework;
  }

  if (detail.runtime) {
    compact.runtime = detail.runtime;
  }

  const react = compactReact(detail);
  if (react) compact.react = react;

  if (detail.next) {
    const next = compactNext(detail.next);
    if (next) compact.next = next;
  }

  const browser = compactBrowser(detail.browser);
  if (browser) compact.browser = browser;

  if (detail.network?.requests?.length) {
    compact.network = detail.network.requests.map(compactNetworkCall);
  }

  return compact;
}

export function toCompactFileDetails(details: FileDetail[]): CompactFileDetail[] {
  return details.map(toCompactFileDetail);
}

// ---------- react ----------

function compactReact(detail: FileDetail): CompactReact | undefined {
  const r = detail.react;
  if (!r) return undefined;

  const hooks = pruneZeroCounts({
    useState: r.hooks.useState,
    useEffect: r.hooks.useEffect,
    useMemo: r.hooks.useMemo,
    useCallback: r.hooks.useCallback,
  });
  const customHooks = r.hooks.customHooks.length ? r.hooks.customHooks : undefined;

  const state = r.state.length ? r.state.map(compactStateVar) : undefined;
  const effects = r.effects.length ? r.effects.map(compactEffectInfo) : undefined;
  const render = compactRender(r.render);
  const context = compactContext(r.context);
  const memoization = compactMemoization(r.memoization);

  const hasHooks = hasAny(hooks) || !!customHooks;
  const isReactFile = hasHooks || !!state || !!effects || !!render || !!context || !!memoization;

  // Drop the whole `react` block when there's genuinely no React signal —
  // e.g. a .ts utility file. This is the article's "React section on a
  // non-React file is pure noise" rule, generalized to "any file with
  // zero React signal, regardless of extension."
  if (!isReactFile) return undefined;

  const out: CompactReact = {};
  if (hasHooks) out.hooks = { ...hooks, ...(customHooks ? { customHooks } : {}) };
  if (state) out.state = state;
  if (effects) out.effects = effects;
  if (render) out.render = render;
  if (context) out.context = context;
  if (memoization) out.memoization = memoization;
  return out;
}

function compactStateVar(s: StateVar): CompactStateVar {
  const out: CompactStateVar = { name: s.name };
  if (s.type) out.type = s.type;
  if (s.initializedWith) out.initializedWith = s.initializedWith;
  if (s.writtenBy.length) out.writtenBy = s.writtenBy;
  if (s.readBy.length) out.readBy = s.readBy;
  return out;
}

function compactEffectInfo(e: EffectInfo): CompactEffectInfo {
  const out: CompactEffectInfo = {};
  if (e.purpose !== 'unknown') out.purpose = e.purpose;
  if (e.dependencies.length) out.dependencies = e.dependencies;
  if (e.networkCalls.length) out.networkCalls = e.networkCalls.map(compactNetworkCall);
  if (e.updatesState.length) out.updatesState = e.updatesState;
  if (e.cleanup) out.cleanup = true;
  return out;
}

function compactRender(render: FileDetail['react']['render']): CompactReact['render'] | undefined {
  const calculations = render.calculations.length
    ? render.calculations.map(compactRenderCalc)
    : undefined;
  const inlineFunctions = render.inlineFunctions.length ? render.inlineFunctions : undefined;
  const listRendering = render.listRendering.length ? render.listRendering : undefined;

  const hasSignal =
    !!calculations ||
    !!inlineFunctions ||
    !!listRendering ||
    render.inlineObjects > 0 ||
    render.inlineArrays > 0 ||
    render.conditionalRendering;

  if (!hasSignal) return undefined;

  const out: CompactReact['render'] = {};
  if (calculations) out.calculations = calculations;
  if (inlineFunctions) out.inlineFunctions = inlineFunctions;
  if (render.inlineObjects) out.inlineObjects = render.inlineObjects;
  if (render.inlineArrays) out.inlineArrays = render.inlineArrays;
  if (render.conditionalRendering) out.conditionalRendering = true;
  if (listRendering) out.listRendering = listRendering;
  return out;
}

function compactRenderCalc(c: RenderCalculation): CompactRenderCalculation {
  const out: CompactRenderCalculation = {
    variable: c.variable,
    operations: c.operations,
    estimatedCost: c.estimatedCost,
  };
  if (c.runsEveryRender) out.runsEveryRender = true;
  return out;
}

function compactContext(context: {
  consumes: string[];
  provides: string[];
}): CompactReact['context'] | undefined {
  if (!context.consumes.length && !context.provides.length) return undefined;
  const out: CompactReact['context'] = {};
  if (context.consumes.length) out.consumes = context.consumes;
  if (context.provides.length) out.provides = context.provides;
  return out;
}

function compactMemoization(mem: {
  reactMemo: boolean;
  useMemo: boolean;
  useCallback: boolean;
}): MemoizationFlag[] | undefined {
  const flags = (Object.keys(mem) as MemoizationFlag[]).filter((k) => mem[k]);
  return flags.length ? flags : undefined;
}

// ---------- browser ----------

function compactBrowser(browser: FileDetail['browser']): BrowserApi[] | undefined {
  const flags = (Object.keys(browser) as BrowserApi[]).filter((k) => browser[k]);
  return flags.length ? flags : undefined;
}

// ---------- network ----------

function compactNetworkCall(call: NetworkCall & { inside?: string }): CompactNetworkCall {
  const out: CompactNetworkCall = { library: call.library };
  if (call.method && call.method !== 'GET') out.method = call.method;
  if (call.url) out.url = call.url;
  if (call.inside === 'useEffect') out.inside = 'useEffect';
  return out;
}

// ---------- next ----------

function compactNext(next: NonNullable<FileDetail['next']>): CompactNext | undefined {
  const out: CompactNext = {};
  if (next.page) out.page = true;
  if (next.layout) out.layout = true;
  if (next.serverComponent) out.serverComponent = true;
  if (next.clientComponent) out.clientComponent = true;
  if (next.serverActions.length) out.serverActions = next.serverActions;

  const metadata: CompactNext['metadata'] = {};
  if (next.metadata.generateMetadata) metadata.generateMetadata = true;
  if (next.metadata.metadataExport) metadata.metadataExport = true;
  if (hasAny(metadata)) out.metadata = metadata;

  const dataFetching: CompactNext['dataFetching'] = {};
  if (next.dataFetching.serverFetch) dataFetching.serverFetch = true;
  if (next.dataFetching.clientFetch) dataFetching.clientFetch = true;
  if (hasAny(dataFetching)) out.dataFetching = dataFetching;

  const routing: CompactNext['routing'] = {};
  if (next.routing.usesSearchParams) routing.usesSearchParams = true;
  if (next.routing.usesParams) routing.usesParams = true;
  if (next.routing.usesRouter) routing.usesRouter = true;
  if (hasAny(routing)) out.routing = routing;

  const cache: CompactNext['cache'] = {};
  if (next.cache.revalidate) cache.revalidate = true;
  if (next.cache.cacheOption) cache.cacheOption = next.cache.cacheOption;
  if (hasAny(cache)) out.cache = cache;

  const assets: CompactNext['assets'] = {};
  if (next.assets.nextImage) assets.nextImage = true;
  if (next.assets.nextFont) assets.nextFont = true;
  if (hasAny(assets)) out.assets = assets;

  const specialFiles: CompactNext['specialFiles'] = {};
  if (next.specialFiles.loading) specialFiles.loading = true;
  if (next.specialFiles.error) specialFiles.error = true;
  if (hasAny(specialFiles)) out.specialFiles = specialFiles;

  return hasAny(out) ? out : undefined;
}

// ---------- shared helpers ----------

function pruneZeroCounts<T extends Record<string, number | undefined>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const val = obj[key];
    if (typeof val === 'number' && val !== 0) out[key] = val;
  }
  return out;
}

function hasAny<T extends object>(obj: T | undefined): boolean {
  return !!obj && Object.keys(obj).length > 0;
}