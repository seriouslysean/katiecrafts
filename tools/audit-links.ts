#!/usr/bin/env -S tsx
/**
 * Crawl built dist/ for dead links via linkinator's JS API.
 *
 * Internal links — relative paths AND full URLs to katiecrafts.com — are
 * checked. An absolute katiecrafts.com URL in post content is semantically
 * the same as a root-relative one and should resolve to a page on the
 * built site; we rewrite the host away so linkinator's local server is the
 * one answering. External third-party hosts are skipped so rot on other
 * people's sites can't block deploys.
 */

import { LinkChecker } from 'linkinator';

// Skip everything that's an external HTTP(S) URL. The negative lookahead
// allows linkinator's own localhost crawl URLs AND any katiecrafts.com
// URLs through so they actually get checked.
const SKIP_PATTERN =
  '^(mailto:|tel:|javascript:|https?://(?!localhost|127\\.0\\.0\\.1|(www\\.)?katiecrafts\\.com))';

const PORT = 5318;
const LOCAL_BASE = `http://localhost:${PORT}`;

const checker = new LinkChecker();
const result = await checker.check({
  path: 'dist',
  port: PORT,
  recurse: true,
  concurrency: 5,
  retryErrors: true,
  retryErrorsCount: 2,
  linksToSkip: [SKIP_PATTERN],
  urlRewriteExpressions: [
    // Treat absolute katiecrafts.com URLs as internal: rewrite the host
    // to the local dist/ server so the check resolves against built pages.
    { pattern: /^https?:\/\/(www\.)?katiecrafts\.com/, replacement: LOCAL_BASE },
  ],
});

const broken = result.links.filter(link => link.state === 'BROKEN');
const skipped = result.links.filter(link => link.state === 'SKIPPED').length;
const ok = result.links.filter(link => link.state === 'OK').length;

if (!broken.length) {
  console.log(`✅ Link audit: ${ok} OK internal, ${skipped} external skipped, 0 broken.`);
  process.exit(0);
}

console.log(`❌ Link audit: ${broken.length} broken internal, ${ok} OK, ${skipped} external skipped.\n`);
const grouped = new Map<number, typeof broken>();
for (const link of broken) {
  const key = link.status ?? 0;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key)!.push(link);
}
for (const [status, items] of Array.from(grouped.entries()).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`── status ${status} (${items.length}) ──`);
  for (const link of items.slice(0, 20)) {
    console.log(`  ${link.url}${link.parent ? `  ← ${link.parent}` : ''}`);
  }
  if (items.length > 20) {
    console.log(`  …and ${items.length - 20} more`);
  }
  console.log('');
}

process.exit(1);
