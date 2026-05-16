#!/usr/bin/env -S tsx

import fs from 'node:fs/promises';
import path from 'node:path';

const CONTENT_ROOT = path.join(process.cwd(), 'src', 'content', 'blog');
const RAW_TAG_PATTERN = /<([a-z][a-z0-9]*)\b(?!:\/\/)[^>]*>/gi;
const ALLOWED_RAW_TAGS = new Set(['figure', 'figcaption', 'div', 'br']);
const MD_IMAGE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)/g;
const MD_LINK_PATTERN = /(?<!!)\[[^\]]+\]\(([^)\s]+)/g;

interface Finding {
  slug: string;
  kind: string;
  detail: string;
}

const findings: Finding[] = [];

const slugs = (await fs.readdir(CONTENT_ROOT, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

const slugSet = new Set(slugs);
const seenSlugsLower = new Map<string, string>();
for (const slug of slugs) {
  const key = slug.toLowerCase();
  const prior = seenSlugsLower.get(key);
  if (prior && prior !== slug) {
    findings.push({ slug, kind: 'duplicate-slug', detail: `case-collision with "${prior}"` });
  }
  seenSlugsLower.set(key, slug);
}

for (const slug of slugs) {
  const dir = path.join(CONTENT_ROOT, slug);
  const file = path.join(dir, 'index.md');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    findings.push({ slug, kind: 'missing-index', detail: 'no index.md in directory' });
    continue;
  }

  const { frontmatter, body } = splitFrontmatter(raw);

  if (!frontmatter.includes('title:')) {
    findings.push({ slug, kind: 'missing-title', detail: 'frontmatter has no title field' });
  } else if (/title:\s*""\s*$/m.test(frontmatter)) {
    findings.push({ slug, kind: 'empty-title', detail: 'title is empty string' });
  }

  if (!frontmatter.includes('publishedDate:')) {
    findings.push({ slug, kind: 'missing-publishedDate', detail: 'frontmatter has no publishedDate' });
  }

  if (!/^excerpt:/m.test(frontmatter)) {
    findings.push({ slug, kind: 'missing-excerpt', detail: 'no excerpt set' });
  }

  if (!/^featuredImage:/m.test(frontmatter)) {
    findings.push({ slug, kind: 'missing-featuredImage', detail: 'no featured image' });
  }

  const tagCounts = new Map<string, number>();
  let match: RegExpExecArray | null;
  RAW_TAG_PATTERN.lastIndex = 0;
  while ((match = RAW_TAG_PATTERN.exec(body)) !== null) {
    const tag = match[1].toLowerCase();
    if (ALLOWED_RAW_TAGS.has(tag)) continue;
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  if (tagCounts.size) {
    const summary = Array.from(tagCounts.entries())
      .map(([tag, count]) => `<${tag}>×${count}`)
      .join(', ');
    findings.push({ slug, kind: 'raw-html-in-body', detail: summary });
  }

  const dirEntries = new Set(
    (await fs.readdir(dir).catch(() => [] as string[])).filter(entry => entry !== 'index.md'),
  );

  MD_IMAGE_PATTERN.lastIndex = 0;
  while ((match = MD_IMAGE_PATTERN.exec(body)) !== null) {
    const url = match[1];
    if (!url.startsWith('./')) continue;
    const file = url.slice(2);
    if (!dirEntries.has(file)) {
      findings.push({ slug, kind: 'missing-body-image', detail: url });
    }
  }

  MD_LINK_PATTERN.lastIndex = 0;
  while ((match = MD_LINK_PATTERN.exec(body)) !== null) {
    const href = match[1];
    if (!href.startsWith('/blog/')) continue;
    const targetSlug = href.replace(/^\/blog\//, '').replace(/\/.*$/, '');
    if (!targetSlug || slugSet.has(targetSlug)) continue;
    findings.push({ slug, kind: 'broken-internal-link', detail: href });
  }
}

if (!findings.length) {
  console.log(`✅ Content audit: ${slugs.length} posts checked, no findings.`);
  process.exit(0);
}

const grouped = new Map<string, Finding[]>();
for (const finding of findings) {
  if (!grouped.has(finding.kind)) grouped.set(finding.kind, []);
  grouped.get(finding.kind)!.push(finding);
}

console.log(`📋 Content audit: ${slugs.length} posts checked, ${findings.length} findings.\n`);
for (const [kind, items] of Array.from(grouped.entries()).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`── ${kind} (${items.length}) ──`);
  for (const item of items.slice(0, 20)) {
    console.log(`  ${item.slug}: ${item.detail}`);
  }
  if (items.length > 20) {
    console.log(`  …and ${items.length - 20} more`);
  }
  console.log('');
}

const blocking = new Set(['missing-index', 'missing-title', 'missing-publishedDate', 'missing-body-image', 'broken-internal-link', 'duplicate-slug']);
const hasBlocker = findings.some(f => blocking.has(f.kind));
process.exit(hasBlocker ? 1 : 0);

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith('---')) return { frontmatter: '', body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: raw };
  return {
    frontmatter: raw.slice(3, end),
    body: raw.slice(end + 4),
  };
}
