#!/usr/bin/env -S tsx
/**
 * Crawl built dist/ for dead links via linkinator's JS API.
 * Skips external social/share intents and links back to the legacy
 * WordPress katiecrafts.com host (which we're migrating away from).
 * Retries transient [0] errors a couple of times before failing them.
 */

import { LinkChecker } from 'linkinator';

const SKIP_PATTERN =
  '^(mailto:|tel:|javascript:|https?://(www\\.)?(katiecrafts|facebook|twitter|x|pinterest|reddit|instagram)\\.com)';

const checker = new LinkChecker();
const result = await checker.check({
  path: 'dist',
  recurse: true,
  concurrency: 5,
  retryErrors: true,
  retryErrorsCount: 2,
  linksToSkip: [SKIP_PATTERN],
});

const broken = result.links.filter(link => link.state === 'BROKEN');
const skipped = result.links.filter(link => link.state === 'SKIPPED').length;
const ok = result.links.filter(link => link.state === 'OK').length;

if (!broken.length) {
  console.log(`✅ Link audit: ${ok} OK, ${skipped} skipped, 0 broken.`);
  process.exit(0);
}

console.log(`❌ Link audit: ${broken.length} broken, ${ok} OK, ${skipped} skipped.\n`);
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
