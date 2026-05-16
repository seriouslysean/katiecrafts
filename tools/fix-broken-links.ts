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
  // Defunct local routes — the WP shop was retired, so links that used to
  // point at /shop/* now go to the Etsy storefront the 404 page redirects to.
  {
    file: 'katie-crafts-will-be-at-spruce-street-harbor-park/index.md',
    ops: [
      { kind: 'replace-url', from: '/shop/category/bandanas/', to: 'https://www.etsy.com/shop/katiecrafts' },
      { kind: 'replace-url', from: '/shop/category/tote-bags/', to: 'https://www.etsy.com/shop/katiecrafts' },
      { kind: 'replace-url', from: '/shop/category/ornaments/', to: 'https://www.etsy.com/shop/katiecrafts' },
      { kind: 'replace-url', from: '/shop/', to: 'https://www.etsy.com/shop/katiecrafts' },
    ],
  },
  // Sponsors page is gone — drop the link, keep the label.
  {
    file: 'may-ad-swap-with-katie-crafts/index.md',
    ops: [{ kind: 'unlink-url', url: '/sponsors/' }],
  },
  // Bare-URL refs from the WP export — the markdown link href is missing
  // its scheme so it resolves as a relative path. The title attribute on
  // the Gabriella link carries the actual destination URL.
  {
    file: 'sunday-funday-issue-8/index.md',
    ops: [{
      kind: 'replace-url',
      from: '/Gabriella%20Miller%20Kids%20First%20Research%20Act/',
      to: 'https://www.govtrack.us/congress/bills/113/hr2019',
    }],
  },
  {
    file: 'featured-etsy-shop-paper-kite-creations/index.md',
    ops: [{
      kind: 'replace-url',
      from: '/paperkitecreations.blogspot.co.nz',
      to: 'http://paperkitecreations.blogspot.co.nz/',
    }],
  },
  {
    file: 'featured-etsy-shop-artful-bits-bytes/index.md',
    ops: [{
      kind: 'replace-url',
      from: '/artfulbitsandbytes.blogspot.com/2013/06/the-making-of-friendship.html',
      to: 'http://artfulbitsandbytes.blogspot.com/2013/06/the-making-of-friendship.html',
    }],
  },
  {
    file: 'featured-etsy-shop-natalias-jewellry/index.md',
    ops: [{
      kind: 'replace-url',
      from: '/www.etsy.com/ca/listing/161601763/wire-wrapped-necklace-made-of-copper/',
      to: 'https://www.etsy.com/ca/listing/161601763/wire-wrapped-necklace-made-of-copper/',
    }],
  },
  // Orphan autolinks from "grab a button" HTML embed code that got rendered
  // as content in the markdown. Each line is a standalone <http://...> with
  // a stray `"/` from the dropped href= attribute.
  {
    file: 'what-are-you-doing-blog-hop-116/index.md',
    ops: [{ kind: 'delete-autolink-substring', substring: 'WAYD.png”/' }],
  },
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
      // Only rewrite when `from` appears inside a markdown link href —
      // `](from)` or `](from "title")`. This keeps the rewrite idempotent
      // (no `](from` left after replace) and avoids accidental nested-URL
      // rewrites when `from` happens to be a substring of `to` (wayback
      // URLs embed the original) or when multiple ops share a `to`.
      if (!next.includes(`](${op.from}`)) continue;
      const before = next;
      next = next.split(`](${op.from})`).join(`](${op.to})`);
      next = next.split(`](${op.from} `).join(`](${op.to} `);
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
