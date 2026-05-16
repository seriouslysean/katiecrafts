/**
 * Shared scrubbers for legacy WordPress URL fragments in migrated
 * content. Used by:
 *   - tools/cleanup-posts.ts  (body markdown, after HTML→md conversion)
 *   - tools/export-posts.ts   (frontmatter alt text, before write)
 *   - tools/strip-wp-urls.ts  (one-shot pass over src/content/blog/)
 *
 * Three classes of refs are removed: /wp-content/ links, katiecrafts.com
 * URLs (the old WP host — we're migrating away), and i[0-9].wp.com photo
 * CDN URLs. Legitimate mailto: addresses are preserved.
 */

export const WP_URL_SCAN_PATTERN = /wp-content|katiecrafts\.com|i[0-9]\.wp\.com/i;
export const WP_URL_COUNT_PATTERN = /wp-content|katiecrafts\.com|i[0-9]\.wp\.com/gi;

export function scrubAltText(alt: string): string {
  let out = alt;
  out = out.replace(
    /\s*[;,]?\s*(?:on|at|from)?\s*Katie Crafts[\s;:]*https?:?\/?\/?(?:www\.)?katiecrafts\.com\/?/gi,
    '',
  );
  out = out.replace(
    /\s*[;,]?\s*https?:?\/?\/?(?:www\.)?katiecrafts\.com\/?/gi,
    '',
  );
  return out.trim();
}

export function scrubMarkdownBody(input: string): string {
  let out = input;

  // Wrapped image link: [![alt](innerLocal)](outerWpUrl) → keep just the image
  out = out.replace(
    /\[(!\[[^\]]*\]\([^)]+\))\]\([^)]*wp-content\/[^)]+\)/g,
    '$1',
  );
  out = out.replace(
    /\[(!\[[^\]]*\]\([^)]+\))\]\(https?:\/\/i[0-9]\.wp\.com\/[^)]+\)/gi,
    '$1',
  );

  // Markdown link with wp-content URL: drop link wrapper, keep label
  out = out.replace(
    /\[([^\]]+)\]\([^)]*wp-content\/[^)]+\)/g,
    '$1',
  );
  // Empty-label link to wp-content: drop entirely
  out = out.replace(
    /\[\]\([^)]*wp-content\/[^)]+\)/g,
    '',
  );

  // Markdown image to wp-content or wp.com CDN (remote, not migrated): drop
  out = out.replace(
    /!\[[^\]]*\]\([^)]*wp-content\/[^)]+\)/g,
    '',
  );
  out = out.replace(
    /!\[[^\]]*\]\(https?:\/\/i[0-9]\.wp\.com\/[^)]+\)/gi,
    '',
  );

  // Image alt trailers inside markdown image alt brackets
  out = out.replace(
    /(!\[[^\]]*?)\s*[;,]?\s*(?:on|at|from)?\s*Katie Crafts[\s;:]*https?:?\/?\/?(?:www\.)?katiecrafts\.com\/?/gi,
    '$1',
  );
  out = out.replace(
    /(!\[[^\]]*?)\s*[;,]?\s*https?:?\/?\/?(?:www\.)?katiecrafts\.com\/?/gi,
    '$1',
  );

  // Markdown link with katiecrafts.com URL → relativize to internal path
  // so the link benefits from client-side routing instead of round-tripping
  // to the legacy WP host.
  out = out.replace(
    /\[([^\]]+)\]\(https?:\/\/(?:www\.)?katiecrafts\.com(\/[^)]*)?\)/g,
    (_match, label, pathPart) => `[${label}](${pathPart || '/'})`,
  );

  // Markdown autolinks <https://katiecrafts.com/path/> → rewrite as a real
  // markdown link [path](path) so the path renders as link text AND the
  // href is internal.
  out = out.replace(
    /<https?:\/\/(?:www\.)?katiecrafts\.com(\/[^>]*)?>/gi,
    (_match, pathPart) => {
      const p = pathPart || '/';
      return `[${p}](${p})`;
    },
  );

  // Bare katiecrafts.com URLs in flowing text → leave just the path
  // (relative URLs don't auto-link in markdown, but the text is preserved
  // for readers and the absolute host is gone).
  out = out.replace(
    /https?:\/\/(?:www\.)?katiecrafts\.com(\/[^\s)"'<>]*)?/gi,
    (_match, pathPart) => pathPart || '/',
  );

  // Markdown autolinks/bare URLs to wp.com CDN or wp-content (true junk,
  // not internal references): drop entirely.
  out = out.replace(/<https?:\/\/[^>]*wp-content\/[^>]*>/gi, '');
  out = out.replace(/<https?:\/\/i[0-9]\.wp\.com\/[^>]+>/gi, '');
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

  // Tidy whitespace artifacts. Anchor on non-space chars to preserve
  // intentional indentation.
  out = out.replace(/(\S)[ \t]+([,.;:])/g, '$1$2');
  out = out.replace(/(\S)[ \t]{2,}(\S)/g, '$1 $2');
  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out;
}

export function scrubFrontmatterAlt(frontmatter: string): string {
  let out = frontmatter;
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
