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

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { LinkChecker } from 'linkinator';

// Skip everything that's an external HTTP(S) URL. The negative lookahead
// allows linkinator's own localhost crawl URLs AND any katiecrafts.com
// URLs through so they actually get checked.
const SKIP_PATTERN =
  '^(mailto:|tel:|javascript:|https?://(?!localhost|127\\.0\\.0\\.1|(www\\.)?katiecrafts\\.com))';

const ROOT = resolve('dist');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Serve dist/ ourselves instead of using linkinator's built-in server.
 *
 * linkinator's server is a plain http.createServer() with Node's default
 * headersTimeout (60s). undici opens connections speculatively; ones that
 * never carry a request are answered with an unsolicited "408 Request
 * Timeout" when the server times them out. If the client picks that socket
 * for a new request at the same moment, that link is reported as 408. The
 * audit takes about a minute on CI, so it lands right on the limit. Node
 * 26's bundled undici (8.x) hits this; Node 24's (7.x) happens not to. See
 * https://github.com/nodejs/node/blob/v26.12.1/lib/_http_server.js
 * (requestTimeoutResponse) and src/node_http_parser.cc (Expired).
 *
 * This is a short-lived local server for a trusted directory, so the
 * header/request timeouts are disabled.
 */
const server = createServer({ headersTimeout: 0, requestTimeout: 0 }, async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    let file = normalize(join(ROOT, decodeURIComponent(pathname)));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403).end();
      return;
    }
    const info = await stat(file);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${pathname}/` }).end();
        return;
      }
      file = join(file, 'index.html');
      await stat(file);
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>(done => server.listen(0, done));
const LOCAL_BASE = `http://localhost:${(server.address() as AddressInfo).port}`;

const checker = new LinkChecker();
const result = await checker.check({
  path: LOCAL_BASE,
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

server.closeAllConnections();
server.close();

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
