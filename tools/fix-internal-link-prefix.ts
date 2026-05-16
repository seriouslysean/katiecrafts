#!/usr/bin/env -S tsx
/**
 * Prefix `/blog/` to bare-slug internal links inside post bodies.
 *
 * Legacy WordPress URLs were `/<slug>/`. The v2 site segments posts under
 * `/blog/<slug>/`, so historical body links like `[hack](/quick-skirt/)`
 * resolve to 404. This script walks every post, builds the slug allow-list
 * from the collection on disk, and rewrites markdown link hrefs that point
 * at a known slug.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.cwd(), 'src', 'content', 'blog');

const slugs = new Set(
  fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name),
);

const linkPattern = /\]\(\/([a-z0-9][a-z0-9-]*)\/([) ])/g;

let totalEdits = 0;
let totalFiles = 0;
const unknownSlugs = new Map<string, number>();

for (const slug of slugs) {
  const filePath = path.join(root, slug, 'index.md');
  if (!fs.existsSync(filePath)) continue;
  const original = fs.readFileSync(filePath, 'utf8');
  let fileEdits = 0;
  const next = original.replace(linkPattern, (match, hrefSlug: string, trailing: string) => {
    if (!slugs.has(hrefSlug)) {
      unknownSlugs.set(hrefSlug, (unknownSlugs.get(hrefSlug) ?? 0) + 1);
      return match;
    }
    fileEdits++;
    return `](/blog/${hrefSlug}/${trailing}`;
  });
  if (fileEdits > 0) {
    fs.writeFileSync(filePath, next);
    totalEdits += fileEdits;
    totalFiles++;
  }
}

console.log(`files changed: ${totalFiles}`);
console.log(`links rewritten: ${totalEdits}`);
if (unknownSlugs.size > 0) {
  console.log(`\nbare-slug refs to unknown targets (left alone):`);
  for (const [slug, count] of [...unknownSlugs].sort((a, b) => b[1] - a[1])) {
    console.log(`  /${slug}/ × ${count}`);
  }
}
