#!/usr/bin/env -S tsx
/**
 * One-shot scrubber for legacy WordPress URLs in src/content/blog/.
 * Removes /wp-content/ refs, katiecrafts.com URL fragments, and
 * i[0-9].wp.com CDN URLs. Keeps legitimate mailto: links intact.
 *
 * Frontmatter (YAML) and body markdown are handled separately so the
 * scrub never touches frontmatter indentation.
 */

import fs from 'node:fs';
import path from 'node:path';

const SCAN_PATTERN = /wp-content|katiecrafts\.com|i[0-9]\.wp\.com/i;
const COUNT_PATTERN = /wp-content|katiecrafts\.com|i[0-9]\.wp\.com/gi;

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
  if (!SCAN_PATTERN.test(raw)) continue;

  const { frontmatter, body, hasFrontmatter } = split(raw);
  const next = hasFrontmatter
    ? `---\n${scrubFrontmatter(frontmatter)}---\n${scrubBody(body)}`
    : scrubBody(raw);

  if (next === raw) continue;
  const before = (raw.match(COUNT_PATTERN) ?? []).length;
  const after = (next.match(COUNT_PATTERN) ?? []).length;
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

function scrubFrontmatter(input: string): string {
  let out = input;
  // alt: "... on Katie Crafts; http://www.katiecrafts.com" → keep descriptive text
  out = out.replace(
    /(alt:\s*"[^"]*?)\s*[;,]?\s*(?:on|at|from)?\s*Katie Crafts[\s;:]*https?:?\/?\/?(?:www\.)?katiecrafts\.com\/?(")/gi,
    '$1$2',
  );
  out = out.replace(
    /(alt:\s*"[^"]*?)\s*[;,]?\s*https?:?\/?\/?(?:www\.)?katiecrafts\.com\/?(")/gi,
    '$1$2',
  );
  return out;
}

function scrubBody(input: string): string {
  let out = input;

  // Wrapped image link: [![alt](innerLocal)](outerWpUrl) → keep just the image
  out = out.replace(
    /\[(!\[[^\]]*\]\([^)]+\))\]\([^)]*wp-content\/[^)]+\)/g,
    '$1',
  );
  // Wrapped image link to wp.com CDN
  out = out.replace(
    /\[(!\[[^\]]*\]\([^)]+\))\]\(https?:\/\/i[0-9]\.wp\.com\/[^)]+\)/gi,
    '$1',
  );

  // Markdown link to wp-content: drop link wrapper, keep label
  out = out.replace(
    /\[([^\]]+)\]\([^)]*wp-content\/[^)]+\)/g,
    '$1',
  );
  // Empty-label link to wp-content: drop entirely
  out = out.replace(
    /\[\]\([^)]*wp-content\/[^)]+\)/g,
    '',
  );

  // Markdown image with wp-content or wp.com CDN src: drop the image
  out = out.replace(
    /!\[[^\]]*\]\([^)]*wp-content\/[^)]+\)/g,
    '',
  );
  out = out.replace(
    /!\[[^\]]*\]\(https?:\/\/i[0-9]\.wp\.com\/[^)]+\)/gi,
    '',
  );

  // Image alt text trailers like "...on Katie Crafts; http://www.katiecrafts.com"
  out = out.replace(
    /(!\[[^\]]*?)\s*[;,]?\s*(?:on|at|from)?\s*Katie Crafts[\s;:]*https?:?\/?\/?(?:www\.)?katiecrafts\.com\/?/gi,
    '$1',
  );
  out = out.replace(
    /(!\[[^\]]*?)\s*[;,]?\s*https?:?\/?\/?(?:www\.)?katiecrafts\.com\/?/gi,
    '$1',
  );

  // Markdown link to katiecrafts.com → relativize to internal path
  out = out.replace(
    /\[([^\]]+)\]\(https?:\/\/(?:www\.)?katiecrafts\.com(\/[^)]*)?\)/g,
    (_match, label, pathPart) => `[${label}](${pathPart || '/'})`,
  );

  // Markdown autolinks <http(s)://...wp-content/...> or <http(s)://katiecrafts.com/...> or wp.com CDN
  out = out.replace(/<https?:\/\/[^>]*wp-content\/[^>]*>/gi, '');
  out = out.replace(/<https?:\/\/(?:www\.)?katiecrafts\.com[^>]*>/gi, '');
  out = out.replace(/<https?:\/\/i[0-9]\.wp\.com\/[^>]+>/gi, '');

  // Bare URLs (no angle brackets) — guard so we don't munch mailto: addresses.
  out = out.replace(/https?:\/\/(?:www\.)?katiecrafts\.com[^\s)"'<>]*/gi, '');
  out = out.replace(/https?:\/\/i[0-9]\.wp\.com\/[^\s)"'<>]+/gi, '');

  // Raw HTML <a>/<img> with WP URLs
  out = out.replace(
    /<a\s[^>]*href=["'][^"']*wp-content\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    '$1',
  );
  out = out.replace(
    /<img\s[^>]*src=["'][^"']*wp-content\/[^"']*["'][^>]*\/?>/gi,
    '',
  );

  // Tidy whitespace artifacts: trailing space before punctuation, multi-spaces
  // inside a line, trailing spaces, more than two blank lines. Indentation is
  // preserved by anchoring on a non-space character.
  out = out.replace(/(\S)[ \t]+([,.;:])/g, '$1$2');
  out = out.replace(/(\S)[ \t]{2,}(\S)/g, '$1 $2');
  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out;
}
