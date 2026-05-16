#!/usr/bin/env -S tsx
/**
 * One-shot fix-up for the broken external links audit flagged.
 * - URLs with Wayback snapshots → rewrite to web.archive.org
 * - URLs without snapshots → unlink (drop the markdown wrapper, keep label)
 * - Orphan autolinks from WP "grab a button" embed-code conversion
 *   artifacts → delete entirely.
 */

import fs from 'node:fs';
import path from 'node:path';

interface Rewrite {
  file: string;
  // For URL substitution: the original URL appears as-is; replace with `to`.
  // For unlink: pattern is the markdown link form `[label](url)`; replace with `label`.
  // For delete: pattern is the full autolink line; delete the matching line.
  ops: Array<
    | { kind: 'replace-url'; from: string; to: string }
    | { kind: 'unlink-url'; url: string }
    | { kind: 'delete-autolink-substring'; substring: string }
  >;
}

const root = path.join(process.cwd(), 'src', 'content', 'blog');

const jobs: Rewrite[] = [
  {
    file: 'sunday-funday-issue-9/index.md',
    ops: [{
      kind: 'replace-url',
      from: 'https://turbotax.intuit.com/tax-tools/tax-tips/General-Tax-Tips/12-Strange-State-Tax-Laws/INF26061.html',
      to: 'http://web.archive.org/web/20160629215016/https://turbotax.intuit.com/tax-tools/tax-tips/General-Tax-Tips/12-Strange-State-Tax-Laws/INF26061.html',
    }],
  },
  {
    file: 'lavender-heart-sachets/index.md',
    ops: [{ kind: 'unlink-url', url: 'http://amzn.to/1aA0eq1' }],
  },
  {
    file: 'sunday-funday-issue-1/index.md',
    ops: [{
      kind: 'replace-url',
      from: 'http://www.plentyphiladelphia.com/',
      to: 'http://web.archive.org/web/20250426230942/https://www.plentyphiladelphia.com/',
    }],
  },
  {
    file: '5-projects-for-2016/index.md',
    ops: [{
      kind: 'replace-url',
      from: 'http://eclecticallyvintage.com/2014/01/craft-supply-organization-tips-chalkboard-labels/?crlt.pid=camp.nzsSHFUuQBPK',
      to: 'http://web.archive.org/web/20160925233238/http://eclecticallyvintage.com/2014/01/craft-supply-organization-tips-chalkboard-labels/',
    }],
  },
  {
    file: 'all-natural-lip-scrub-recipe/index.md',
    ops: [{
      kind: 'replace-url',
      from: 'http://www.tassotapiaries.com/',
      to: 'http://web.archive.org/web/20260310095805/https://tassotapiaries.com/',
    }],
  },
  {
    file: 'liebster-award/index.md',
    ops: [{
      kind: 'replace-url',
      from: 'http://www.katrinaalana.com/blog/',
      to: 'http://web.archive.org/web/20191117122258/http://www.katrinaalana.com/blog/',
    }],
  },
  {
    file: 'a-special-look-at-my-fall-wedding/index.md',
    ops: [{
      kind: 'replace-url',
      from: 'http://www.littlebluebox.photo/',
      to: 'http://web.archive.org/web/20250314180803/https://www.littlebluebox.photo/',
    }],
  },
  {
    file: 'crocheted-amigurumi-hippo-pattern/index.md',
    ops: [{
      kind: 'replace-url',
      from: 'http://shop.hobbylobby.com/products/aqua-sparkle-i-love-this-cotton-yarn-110213/',
      to: 'http://web.archive.org/web/20150624054621/http://shop.hobbylobby.com/products/aqua-sparkle-i-love-this-cotton-yarn-110213/',
    }],
  },
  // Orphan autolinks from "grab a button" HTML embed code that got rendered
  // as content in the markdown. Each line is a standalone <http://...> with
  // a stray `"/` from the dropped href= attribute.
  {
    file: 'what-are-you-doing-blog-hop-117/index.md',
    ops: [{ kind: 'delete-autolink-substring', substring: 'WAYD.png”/' }],
  },
  {
    file: 'wayd-114/index.md',
    ops: [{ kind: 'delete-autolink-substring', substring: 'CMfeatured150.png”/' }],
  },
  {
    file: 'yarn-bombing-what-are-you-doing-blog-hop-113-2/index.md',
    ops: [
      { kind: 'delete-autolink-substring', substring: 'WAYD.png”/' },
      { kind: 'delete-autolink-substring', substring: 'CMfeatured150.png”/' },
    ],
  },
];

let totalEdits = 0;
let totalFiles = 0;

for (const job of jobs) {
  const filePath = path.join(root, job.file);
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  missing: ${job.file}`);
    continue;
  }
  const original = fs.readFileSync(filePath, 'utf8');
  let next = original;
  let appliedOps = 0;

  for (const op of job.ops) {
    if (op.kind === 'replace-url') {
      const before = next;
      next = next.split(op.from).join(op.to);
      if (next !== before) appliedOps++;
    } else if (op.kind === 'unlink-url') {
      // [label](url) → label
      const escaped = op.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\[([^\\]]+)\\]\\(${escaped}(?:\\s+"[^"]*")?\\)`, 'g');
      const before = next;
      next = next.replace(re, '$1');
      if (next !== before) appliedOps++;
    } else if (op.kind === 'delete-autolink-substring') {
      // Drop entire lines that contain a <http...substring...> autolink.
      const before = next;
      const lines = next.split('\n');
      const kept = lines.filter(line => !(line.includes('<http') && line.includes(op.substring)));
      next = kept.join('\n');
      // Collapse runs of blank lines created by the deletion.
      next = next.replace(/\n{3,}/g, '\n\n');
      if (next !== before) appliedOps++;
    }
  }

  if (appliedOps === 0) {
    console.warn(`⚠️  no-op: ${job.file} (patterns not found)`);
    continue;
  }
  fs.writeFileSync(filePath, next);
  totalEdits += appliedOps;
  totalFiles++;
  console.log(`  ${job.file}: ${appliedOps} op(s) applied`);
}

console.log(`\nfiles changed: ${totalFiles}`);
console.log(`ops applied: ${totalEdits}`);
