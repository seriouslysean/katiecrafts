#!/usr/bin/env -S tsx
/**
 * Re-runnable scrubber for legacy WordPress URLs in src/content/blog/.
 * The same scrub patterns are applied by tools/cleanup-posts.ts on
 * the import pipeline; this tool is for sweeping content that wasn't
 * routed through the pipeline (e.g., hand-edited files).
 *
 * Frontmatter (YAML) and body markdown are scrubbed separately so YAML
 * indentation is never touched.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  WP_URL_SCAN_PATTERN,
  WP_URL_COUNT_PATTERN,
  scrubFrontmatterAlt,
  scrubMarkdownBody,
} from './lib/scrub-wp-urls.ts';

const root = path.join(process.cwd(), 'src', 'content', 'blog');
const slugs = fs
  .readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);

let filesChanged = 0;
let refsRemoved = 0;

for (const slug of slugs) {
  const file = path.join(root, slug, 'index.md');
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  if (!WP_URL_SCAN_PATTERN.test(raw)) continue;

  const { frontmatter, body, hasFrontmatter } = split(raw);
  const next = hasFrontmatter
    ? `---\n${scrubFrontmatterAlt(frontmatter)}---\n${scrubMarkdownBody(body)}`
    : scrubMarkdownBody(raw);

  if (next === raw) continue;
  const before = (raw.match(WP_URL_COUNT_PATTERN) ?? []).length;
  const after = (next.match(WP_URL_COUNT_PATTERN) ?? []).length;
  filesChanged++;
  refsRemoved += before - after;
  fs.writeFileSync(file, next);
  console.log(`  ${slug}: ${before - after} ref(s) removed (${after} remaining)`);
}

console.log(`\nfiles changed: ${filesChanged}`);
console.log(`refs removed: ${refsRemoved}`);

function split(raw: string): { frontmatter: string; body: string; hasFrontmatter: boolean } {
  if (!raw.startsWith('---\n')) return { frontmatter: '', body: raw, hasFrontmatter: false };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: '', body: raw, hasFrontmatter: false };
  return {
    frontmatter: raw.slice(4, end + 1),
    body: raw.slice(end + 5),
    hasFrontmatter: true,
  };
}
