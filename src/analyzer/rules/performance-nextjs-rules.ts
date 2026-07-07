import { Node, SourceFile } from 'ts-morph';
import * as fs from 'fs';
import * as path from 'path';
import { RuleResult, finding } from './rule.types';
import { getCallName } from './ast-utils';

export function checkPerformanceRules(sourceFile: SourceFile, filePath: string): RuleResult[] {
  const results: RuleResult[] = [];

  sourceFile.forEachDescendant((node) => {
    // arrow function created inline inside .map(), passed as a JSX event handler
    if (Node.isJsxAttribute(node)) {
      const nameNode = node.getNameNode().getText();
      const init = node.getInitializer();
      if (/^on[A-Z]/.test(nameNode) && init && Node.isJsxExpression(init)) {
        const expr = init.getExpression();
        if (expr && (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr))) {
          const inMap = node.getFirstAncestor((a) => {
            const callName = getCallName(a);
            return callName === 'map';
          });
          if (inMap) {
            results.push(finding({
              id: 'function-recreated-in-map', category: 'performance', severity: 'low',
              title: `Inline handler recreated inside .map(): ${nameNode}`,
              description: 'A new function is created on every render for every item in the list.',
              line: node.getStartLineNumber(),
              recommendation: 'Extract a memoized handler, or pass the item id and a single stable callback.',
            }, filePath));
          }
        }
      }

      // object/array literals recreated inline (style={{}}, items={[...]})
      if (init && Node.isJsxExpression(init)) {
        const expr = init.getExpression();
        if (expr && Node.isObjectLiteralExpression(expr)) {
          results.push(finding({
            id: 'object-recreated-in-render', category: 'performance', severity: 'info',
            title: `Object literal recreated on every render: ${nameNode}`,
            description: 'This object is created fresh on every render, defeating memoized children.',
            line: node.getStartLineNumber(),
            recommendation: 'Hoist the object outside the component or wrap it in useMemo.',
          }, filePath));
        }
        if (expr && Node.isArrayLiteralExpression(expr)) {
          results.push(finding({
            id: 'array-recreated-in-render', category: 'performance', severity: 'info',
            title: `Array literal recreated on every render: ${nameNode}`,
            description: 'This array is created fresh on every render.',
            line: node.getStartLineNumber(),
            recommendation: 'Hoist the array outside the component or wrap it in useMemo.',
          }, filePath));
        }
      }
    }

    // filter/sort chains and map-inside-map inside JSX
    if (Node.isJsxExpression(node)) {
      const expr = node.getExpression();
      if (expr) {
        let filterCount = 0;
        expr.forEachDescendant((d) => {
          const cn = getCallName(d);
          if (cn === 'filter') filterCount++;
        });
        if (filterCount >= 2) {
          results.push(finding({
            id: 'multiple-filters', category: 'performance', severity: 'low',
            title: 'Chained .filter() calls inside JSX',
            description: `${filterCount} .filter() calls chained directly in the render path.`,
            line: node.getStartLineNumber(),
            recommendation: 'Combine into a single filter predicate, or precompute with useMemo.',
          }, filePath));
        } else {
          const cn = expr && Node.isCallExpression(expr) ? getCallName(expr) : null;
          if (cn === 'filter') {
            results.push(finding({
              id: 'expensive-filter-in-jsx', category: 'performance', severity: 'info',
              title: '.filter() called directly inside JSX',
              description: 'Filtering runs on every render.',
              line: node.getStartLineNumber(),
              recommendation: 'Precompute the filtered list with useMemo.',
            }, filePath));
          }
        }

        let mapDepth = 0;
        const walk = (n: Node, depth: number) => {
          const cn2 = getCallName(n);
          const next = cn2 === 'map' ? depth + 1 : depth;
          if (next > mapDepth) mapDepth = next;
          n.forEachChild((c) => walk(c, next));
        };
        walk(expr, 0);
        if (mapDepth > 1) {
          results.push(finding({
            id: 'map-inside-map', category: 'performance', severity: 'low',
            title: 'Nested .map() calls in render',
            description: `${mapDepth} levels of nested .map() found in one JSX expression.`,
            line: node.getStartLineNumber(),
            recommendation: 'Flatten the data before rendering, or extract an inner list component.',
          }, filePath));
        }
      }
    }

    if (Node.isCallExpression(node)) {
      const cn = getCallName(node);
      if (cn === 'sort') {
        const inJsx = node.getFirstAncestor((a) => Node.isJsxExpression(a));
        if (inJsx) {
          results.push(finding({
            id: 'sort-inside-render', category: 'performance', severity: 'info',
            title: '.sort() called directly in render',
            description: 'Sorting on every render is wasted work if the underlying data is stable, and .sort() mutates in place.',
            line: node.getStartLineNumber(),
            recommendation: 'Precompute a sorted copy with useMemo.',
          }, filePath));
        }
      }
    }
  });

  return results;
}

export function checkNextjsFileRules(sourceFile: SourceFile, filePath: string): RuleResult[] {
  const results: RuleResult[] = [];
  const fullText = sourceFile.getFullText();
  const isClient = /^\s*['"]use client['"]/.test(fullText);
  const isApiRoute = /[\\/]pages[\\/]api[\\/]/.test(filePath) || /[\\/]app[\\/].*[\\/]route\.(ts|tsx|js|jsx)$/.test(filePath);

  if (isApiRoute) {
    const loc = sourceFile.getEndLineNumber();
    if (loc > 300) {
      results.push(finding({
        id: 'api-route-too-large', category: 'nextjs', severity: 'high',
        title: 'API route too large', description: `Route handler is ${loc} lines.`,
        metric: { actual: loc, threshold: 300, unit: 'lines' },
        recommendation: 'Extract business logic into service functions and keep the route thin.',
      }, filePath));
    }
  }

  if (isClient) {
    let hasFsImport = false;
    let hasFetch = false;
    sourceFile.getImportDeclarations().forEach((imp) => {
      if (imp.getModuleSpecifierValue() === 'fs' || imp.getModuleSpecifierValue() === 'node:fs') hasFsImport = true;
    });
    sourceFile.forEachDescendant((n) => {
      const cn = getCallName(n);
      if (cn === 'fetch') hasFetch = true;
    });

    if (hasFsImport) {
      results.push(finding({
        id: 'client-importing-fs', category: 'nextjs', severity: 'critical',
        title: "Client component imports 'fs'",
        description: "This file has 'use client' but imports a Node.js-only module, which will break the client bundle.",
        recommendation: 'Move filesystem access to a Server Component or an API route.',
      }, filePath));
    }
    if (hasFetch) {
      results.push(finding({
        id: 'fetch-inside-client', category: 'nextjs', severity: 'info',
        title: 'fetch() inside a Client Component',
        description: 'Data fetching here happens in the browser instead of on the server.',
        recommendation: 'Prefer fetching in a Server Component and passing data down as props where possible.',
      }, filePath));
    }
  }

  // <img> instead of next/image, <a> instead of next/link
  sourceFile.forEachDescendant((n) => {
    const tag = Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n) ? n.getTagNameNode().getText() : null;
    if (tag === 'img') {
      results.push(finding({
        id: 'img-instead-of-next-image', category: 'nextjs', severity: 'low',
        title: 'Native <img> instead of next/image',
        description: 'next/image provides automatic optimization, lazy loading, and layout stability.',
        line: n.getStartLineNumber(),
        recommendation: "Replace with <Image> from 'next/image'.",
      }, filePath));
    }
    if (tag === 'a') {
      const hasHref = Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n)
        ? n.getAttributes().some((a) => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'href' && /^\/(?!\/)/.test(a.getInitializer()?.getText() ?? ''))
        : false;
      if (hasHref) {
        results.push(finding({
          id: 'anchor-instead-of-next-link', category: 'nextjs', severity: 'low',
          title: 'Native <a> for an internal route instead of next/link',
          description: 'Using <a> for internal navigation causes a full page reload instead of client-side routing.',
          line: n.getStartLineNumber(),
          recommendation: "Replace with <Link> from 'next/link'.",
        }, filePath));
      }
    }
  });

  return results;
}

/** Repo-wide, filesystem-based Next.js App Router conventions — not per-file AST rules. */
export function checkNextConventionRules(localPath: string): RuleResult[] {
  const results: RuleResult[] = [];
  const appDir = path.join(localPath, 'app');
  if (!fs.existsSync(appDir)) return results;

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const hasPage = files.some((f) => /^page\.(tsx|ts|jsx|js)$/.test(f));
    const relDir = path.relative(localPath, dir).split(path.sep).join('/');

    if (hasPage) {
      if (!files.some((f) => /^loading\.(tsx|ts|jsx|js)$/.test(f))) {
        results.push(finding({
          id: 'missing-loading-file', category: 'nextjs', severity: 'info',
          title: 'Missing loading.tsx', description: `${relDir} has a page but no loading state.`,
          recommendation: 'Add a loading.tsx for a better perceived-performance / Suspense fallback.',
        }, `${relDir}/page`));
      }
      if (!files.some((f) => /^error\.(tsx|ts|jsx|js)$/.test(f))) {
        results.push(finding({
          id: 'missing-error-file', category: 'nextjs', severity: 'low',
          title: 'Missing error.tsx', description: `${relDir} has a page but no error boundary.`,
          recommendation: 'Add an error.tsx so failures in this segment don\'t crash the whole tree.',
        }, `${relDir}/page`));
      }
    }

    entries.filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .forEach((e) => walk(path.join(dir, e.name)));
  };

  walk(appDir);

  if (!fs.existsSync(path.join(appDir, 'not-found.tsx')) && !fs.existsSync(path.join(appDir, 'not-found.ts'))) {
    results.push(finding({
      id: 'missing-not-found-file', category: 'nextjs', severity: 'info',
      title: 'Missing root not-found.tsx',
      description: 'No custom 404 page defined at the app root.',
      recommendation: 'Add app/not-found.tsx for a branded 404 experience.',
    }, 'app/not-found'));
  }

  return results;
}