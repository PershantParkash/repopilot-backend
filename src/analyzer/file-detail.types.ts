// analyzer/file-detail.types.ts
import { RuleResult } from './rules/rule.types';

export type FileKind = 'page' | 'layout' | 'component' | 'hook' | 'api-route' | 'other';
export type FrameworkKind = 'react' | 'next';

export interface StateVar {
  name: string;
  type: string | null;
  initializedWith: string | null;
  writtenBy: string[];
  readBy: string[];
}

export interface NetworkCall {
  library: 'fetch' | 'axios';
  method: string;
  url: string | null;
}

export interface EffectInfo {
  purpose: 'data-fetch' | 'subscription' | 'dom' | 'unknown';
  dependencies: string[];
  networkCalls: NetworkCall[];
  updatesState: string[];
  cleanup: boolean;
}

export interface RenderCalculation {
  variable: string;
  operations: string[];
  dependsOn: string[];
  estimatedCost: 'low' | 'medium' | 'high';
  runsEveryRender: boolean;
}

export interface FileDetail {
  file: string;
  framework: FrameworkKind;
  kind: FileKind;
  runtime?: { component: 'client' | 'server'; reason: string };
  summary: {
    lines: number;
    imports: number;
    exports: number;
    cyclomaticComplexity: number;
    jsxDepth: number;
  };
  react: {
    hooks: {
      useState: number;
      useEffect: number;
      useMemo: number;
      useCallback: number;
      customHooks: string[];
    };
    state: StateVar[];
    effects: EffectInfo[];
    render: {
      calculations: RenderCalculation[];
      inlineFunctions: { name: string; passedToChild: boolean }[];
      inlineObjects: number;
      inlineArrays: number;
      conditionalRendering: boolean;
      listRendering: { source: string; key: string | null }[];
    };
    context: { consumes: string[]; provides: string[] };
    memoization: { reactMemo: boolean; useMemo: boolean; useCallback: boolean };
  };
  next?: {
    page: boolean;
    layout: boolean;
    serverComponent: boolean;
    clientComponent: boolean;
    serverActions: string[];
    metadata: { generateMetadata: boolean; metadataExport: boolean };
    dataFetching: { serverFetch: boolean; clientFetch: boolean };
    routing: { usesSearchParams: boolean; usesParams: boolean; usesRouter: boolean };
    cache: { revalidate: boolean; cacheOption: string | null };
    assets: { nextImage: boolean; nextFont: boolean };
    specialFiles: { loading: boolean; error: boolean };
  };
  browser: {
    window: boolean;
    document: boolean;
    localStorage: boolean;
    sessionStorage: boolean;
    cookies: boolean;
    navigator: boolean;
    clipboard: boolean;
  };
  network: { requests: Array<NetworkCall & { inside: string }> };
  architecture: {
    imports: { components: number; hooks: number; services: number; utils: number; store: number };
    dependencyCount: number;
    exports: string[];
  };
  findings: RuleResult[];
}