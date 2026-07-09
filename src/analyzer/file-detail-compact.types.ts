// analyzer/file-detail-compact.types.ts
//
// Lean mirror of FileDetail for AI-consumption. Every field here is optional
// because the whole point is: if it's empty/false/zero/default, we omit the
// key rather than serialize a default value. See file-detail-serializer.ts.

import { FileKind, FrameworkKind } from './file-detail.types';
import { RuleResult } from './rules/rule.types';

export type BrowserApi =
  | 'window'
  | 'document'
  | 'localStorage'
  | 'sessionStorage'
  | 'cookies'
  | 'navigator'
  | 'clipboard';

export type MemoizationFlag = 'reactMemo' | 'useMemo' | 'useCallback';

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export interface CompactFileDetail {
  file: string;
  framework?: FrameworkKind;
  kind: FileKind;
  runtime?: { component: 'client' | 'server'; reason: string };
  summary: {
    lines: number;
    imports: number;
    exports: number;
    cyclomaticComplexity: number;
    jsxDepth?: number;
  };
  riskScore: number;
  riskLevel: RiskLevel;
  react?: CompactReact;
  next?: CompactNext;
  browser?: BrowserApi[];
  network?: CompactNetworkCall[];
  architecture: {
    imports?: Partial<Record<'components' | 'hooks' | 'services' | 'utils' | 'store', number>>;
    dependencyCount: number;
    exports: string[];
  };
  findings: RuleResult[];
}

export interface CompactNetworkCall {
  library: 'fetch' | 'axios';
  method?: string; // omitted when 'GET' (the default)
  url?: string; // omitted when null/empty
  inside?: 'useEffect'; // omitted when 'render' (the common case)
}

export interface CompactStateVar {
  name: string;
  type?: string;
  initializedWith?: string;
  writtenBy?: string[];
  readBy?: string[];
}

export interface CompactEffectInfo {
  purpose?: 'data-fetch' | 'subscription' | 'dom'; // omitted when 'unknown'
  dependencies?: string[];
  networkCalls?: CompactNetworkCall[];
  updatesState?: string[];
  cleanup?: true; // omitted when false
}

export interface CompactRenderCalculation {
  variable: string;
  operations: string[];
  estimatedCost: 'low' | 'medium' | 'high';
  runsEveryRender?: true; // omitted when false
}

export interface CompactRender {
  calculations?: CompactRenderCalculation[];
  inlineFunctions?: { name: string; passedToChild: boolean }[];
  inlineObjects?: number;
  inlineArrays?: number;
  conditionalRendering?: true; // omitted when false
  listRendering?: { source: string; key: string | null }[];
}

export interface CompactReact {
  hooks?: {
    useState?: number;
    useEffect?: number;
    useMemo?: number;
    useCallback?: number;
    customHooks?: string[];
  };
  state?: CompactStateVar[];
  effects?: CompactEffectInfo[];
  render?: CompactRender;
  context?: { consumes?: string[]; provides?: string[] };
  memoization?: MemoizationFlag[];
}

export interface CompactNext {
  page?: true;
  layout?: true;
  serverComponent?: true;
  clientComponent?: true;
  serverActions?: string[];
  metadata?: { generateMetadata?: true; metadataExport?: true };
  dataFetching?: { serverFetch?: true; clientFetch?: true };
  routing?: { usesSearchParams?: true; usesParams?: true; usesRouter?: true };
  cache?: { revalidate?: true; cacheOption?: string };
  assets?: { nextImage?: true; nextFont?: true };
  specialFiles?: { loading?: true; error?: true };
}

// export interface CompactFileDetail {
//   file: string;
//   framework?: FrameworkKind; // omitted when 'react' (the project default)
//   kind: FileKind;
//   runtime?: { component: 'client' | 'server'; reason: string };
//   summary: {
//     lines: number;
//     imports: number;
//     exports: number;
//     cyclomaticComplexity: number;
//     jsxDepth?: number; // omitted when 0
//   };
//   react?: CompactReact; // omitted entirely when the file has no React signal
//   next?: CompactNext;
//   browser?: BrowserApi[]; // omitted when no browser API usage detected
//   network?: CompactNetworkCall[]; // flattened; omitted when no requests
//   architecture: {
//     imports?: Partial<Record<'components' | 'hooks' | 'services' | 'utils' | 'store', number>>;
//     dependencyCount: number;
//     exports: string[];
//   };
//   findings: RuleResult[]; // never trimmed — highest-value part per the review
// }

