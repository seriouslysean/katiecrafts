#!/usr/bin/env -S tsx

/**
 * WordPress to Astro Content Migration Tool
 *
 * Fetches all blog posts from WordPress REST API and converts them to
 * structured JSON files for Astro Content Collections.
 *
 * Usage:
 *   npm run tool:import-wordpress
 *   npm run tool:import-wordpress -- --dry-run
 *   npm run tool:import-wordpress -- --start-page=10
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import axios, { AxiosError } from 'axios';
import { decode } from 'entities';
import { parse, HTMLElement, TextNode } from 'node-html-parser';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { WordPressPost, PostData, FeaturedImageMeta } from '~types/post';

// Configuration
const SITE_ORIGIN = 'https://www.katiecrafts.com';
const WP_API_BASE = `${SITE_ORIGIN}/wp-json/wp/v2`;
const POSTS_PER_PAGE = 6;
const DATA_DIR = path.join(process.cwd(), 'data');
const POSTS_BASE_DIR = path.join(DATA_DIR, 'posts');
const BLOG_PAGES_DIR = path.join(process.cwd(), 'src', 'pages', 'blog');
const MANIFEST_FILE = path.join(DATA_DIR, 'import-manifest.json');
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // ms
const INTERNAL_HOSTNAMES = new Set(['www.katiecrafts.com', 'katiecrafts.com']);
const WORDPRESS_CDN_HOSTS = new Set(['i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'i3.wp.com']);

function normalizeWordPressImageUrl(url: URL): URL {
  const normalized = new URL(url.href);
  normalized.search = '';
  const ext = path.posix.extname(normalized.pathname);
  const dir = path.posix.dirname(normalized.pathname);
  const base = path.posix.basename(normalized.pathname, ext);
  let stripped = base.replace(/-\d+x\d+$/i, '').replace(/-scaled$/i, '');
  if (!stripped.length) stripped = base;
  normalized.pathname = `${dir === '/' ? '' : dir}/${stripped}${ext}`;
  return normalized;
}

function buildImageCandidates(url: URL): URL[] {
  const original = new URL(url.href);
  const candidates: URL[] = [original];
  const normalized = normalizeWordPressImageUrl(url);
  if (
    normalized.pathname !== original.pathname ||
    normalized.search !== original.search ||
    normalized.origin !== original.origin
  ) {
    candidates.push(normalized);
  }
  return candidates;
}

// Parse command line arguments
const argv = await yargs(hideBin(process.argv))
  .option('dry-run', {
    type: 'boolean',
    description: 'Run without saving files',
    default: false,
  })
  .option('start-page', {
    type: 'number',
    description: 'Page number to start from',
    default: 1,
  })
  .option('max-pages', {
    type: 'number',
    description: 'Maximum number of pages to fetch (for testing)',
  })
  .parse();

// State management for resume capability
interface ImportManifest {
  lastCompletedPage: number;
  totalPosts: number;
  importedPosts: string[];
  lastRun: string;
}

// Helper: Sleep function
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Retry with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES,
  delay = RETRY_DELAY
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      if (status && status >= 400 && status < 500) {
        throw error;
      }
    }
    if (retries === 0) throw error;
    console.log(`  ⚠️  Retrying in ${delay}ms... (${retries} attempts left)`);
    await sleep(delay);
    return retryWithBackoff(fn, retries - 1, delay * 2);
  }
}

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}

function getFileExtension(url: URL): string {
  const ext = path.extname(url.pathname).toLowerCase();
  if (ext && ext.length <= 5) {
    return ext;
  }
  return '.jpg';
}

function sanitizeFilenameSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildImageFilename(baseName: string, ext: string, usedFilenames: Set<string>): string {
  const sanitized = sanitizeFilenameSegment(baseName);
  const base = sanitized || 'image';
  let candidate = `${base}${ext}`;
  let counter = 2;
  while (usedFilenames.has(candidate)) {
    candidate = `${base}-${counter}${ext}`;
    counter += 1;
  }
  usedFilenames.add(candidate);
  return candidate;
}

function normalizeInternalHref(url: URL): string {
  const hasExtension = Boolean(path.extname(url.pathname));
  let pathname = url.pathname;

  if (!hasExtension && !pathname.endsWith('/')) {
    pathname = `${pathname}/`;
  }

  return `${pathname}${url.search}${url.hash}`;
}

// Load or create manifest
async function loadManifest(): Promise<ImportManifest> {
  try {
    const data = await fs.readFile(MANIFEST_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {
      lastCompletedPage: 0,
      totalPosts: 0,
      importedPosts: [],
      lastRun: new Date().toISOString(),
    };
  }
}

// Save manifest
async function saveManifest(manifest: ImportManifest): Promise<void> {
  if (argv.dryRun) return;
  await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

// Ensure directories exist
async function ensureDirectories(): Promise<void> {
  if (argv.dryRun) return;
  await fs.mkdir(POSTS_BASE_DIR, { recursive: true });
  await fs.mkdir(BLOG_PAGES_DIR, { recursive: true });
}

function preprocessHtml(html: string): string {
  return html.replace(/<!--more-->/g, '');
}

function normalizeTextareas(root: HTMLElement): void {
  root.querySelectorAll('textarea').forEach(node => {
    const textContent = node.textContent ?? '';
    const urls = Array.from(new Set(textContent.match(/https?:\/\/[^\s"'<>]+/g) ?? []));

    if (urls.length === 0) {
      node.remove();
      return;
    }

    const fragments = urls
      .map(url => {
        const parsed = parse(`<p class="post__embed-link"><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></p>`);
        return parsed.firstChild as HTMLElement | null;
      })
      .filter((fragment): fragment is HTMLElement => fragment !== null);

    if (fragments.length) {
      node.replaceWith(...fragments);
    } else {
      node.remove();
    }
  });
}

function sanitizeUnsupportedNodes(root: HTMLElement): void {
  const dropSelectors = [
    'script',
    'style',
    'iframe',
    'form',
    'input',
    'select',
    'option',
    'button',
    'svg',
    'canvas',
    'noscript',
    'object',
    'embed',
  ].join(',');

  root.querySelectorAll(dropSelectors).forEach(node => node.remove());

  root.querySelectorAll('table').forEach(table => {
    const rows = table.querySelectorAll('tr');
    const replacements: HTMLElement[] = [];

    rows.forEach(row => {
      const cells = row.querySelectorAll('th, td');
      const segments = cells
        .map(cell => cell.innerHTML.trim())
        .filter(Boolean);

      if (segments.length) {
      const wrapper = parse(`<p>${segments.join(' ')}</p>`);
      const paragraph = wrapper.firstChild as HTMLElement | null;
        if (paragraph) {
          replacements.push(paragraph);
        }
      }
    });

    if (replacements.length) {
      table.replaceWith(...replacements);
    } else {
      table.remove();
    }
  });
}

function wrapOrphanTextNodes(node: HTMLElement): void {
  const childNodes = [...node.childNodes];

  for (const child of childNodes) {
    if (child instanceof TextNode) {
      const text = child.text.trim();
      if (!text) {
        child.remove();
        continue;
      }

      const wrapper = parse(`<p>${text}</p>`);
      const paragraph = wrapper.firstChild as HTMLElement | null;
      if (paragraph) {
        const parent = child.parentNode;
        if (parent) {
          const index = parent.childNodes.indexOf(child);
          parent.childNodes.splice(index, 1, paragraph);
        }
      }
    } else if (child instanceof HTMLElement) {
      wrapOrphanTextNodes(child);
    }
  }
}

function standardizeGalleries(root: HTMLElement): void {
  root.querySelectorAll('.gallery').forEach(gallery => {
    gallery.removeAttribute('id');
    gallery.setAttribute('class', 'post__gallery');

    gallery.querySelectorAll('.gallery-item').forEach(item => {
      const img = item.querySelector('img');
      if (!img) return;

      const src = img.getAttribute('src') ?? '';
      const alt = img.getAttribute('alt') ?? '';
      const width = img.getAttribute('width') ?? '';
      const height = img.getAttribute('height') ?? '';

      item.replaceWith(
        `<div class="post__gallery-item">
          <img class="post__gallery-image" src="${src}" alt="${alt}" width="${width}" height="${height}" loading="lazy" decoding="async" />
        </div>`
      );
    });
  });
}

function removeEmptyParagraphs(root: HTMLElement): void {
  root.querySelectorAll('p').forEach(paragraph => {
    const hasMedia = paragraph.querySelector('img, video, iframe, picture') !== null;
    if (hasMedia) return;

    const inner = paragraph.innerHTML
      .replace(/&nbsp;/gi, '')
      .replace(/<br\s*\/?>(\s|&nbsp;)*/gi, '')
      .trim();

    const text = paragraph.text.trim();

    if (!inner.length || !text.length) {
      paragraph.remove();
    }
  });
}

function rewriteInternalLinks(root: HTMLElement): void {
  root.querySelectorAll('a[href]').forEach(anchor => {
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;

    let url: URL;
    try {
      url = new URL(href, SITE_ORIGIN);
    } catch {
      return;
    }

    if (INTERNAL_HOSTNAMES.has(url.hostname)) {
      const normalized = normalizeInternalHref(url);
      anchor.setAttribute('href', normalized);
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
    } else {
      anchor.setAttribute('target', '_blank');
      const rel = new Set(
        (anchor.getAttribute('rel') ?? '')
          .split(/\s+/)
          .filter(Boolean)
      );
      rel.add('noopener');
      rel.add('noreferrer');
      anchor.setAttribute('rel', Array.from(rel).join(' '));
    }
  });
}

function convertPseudoLists(root: HTMLElement): void {
  const paragraphs = Array.from(root.querySelectorAll('p'));
  const buffer: HTMLElement[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const items = buffer
      .map(paragraph => {
        const raw = paragraph.innerHTML.trim();
        const cleaned = raw.replace(/^([-–•]+\s*|&nbsp;)+/i, '').trim();
        return cleaned.length ? `<li>${cleaned}</li>` : '';
      })
      .filter(Boolean)
      .join('');

    if (!items.length) {
      buffer.length = 0;
      return;
    }

    const listHtml = `<ul>${items}</ul>`;
    const listNode = parse(listHtml);
    const first = buffer[0];
    first.replaceWith(listNode);
    buffer.slice(1).forEach(node => node.remove());
    buffer.length = 0;
  };

  for (const paragraph of paragraphs) {
    const text = paragraph.text.trim();
    const isBullet = /^[-–•]\s*/.test(text);
    if (isBullet) {
      buffer.push(paragraph);
      continue;
    }

    flushBuffer();
  }

  flushBuffer();
}

async function localizeImages(
  root: HTMLElement,
  slug: string,
  postImageDataDir: string
): Promise<void> {
  const downloads = new Map<string, string>();
  const usedFilenames = new Set<string>();

  for (const img of root.querySelectorAll('img')) {
    const sourceAttr =
      img.getAttribute('data-src') ??
      img.getAttribute('data-lazy-src') ??
      img.getAttribute('src');

    if (!sourceAttr) continue;

    let originalUrl: URL;
    try {
      originalUrl = new URL(sourceAttr, SITE_ORIGIN);
    } catch {
      continue;
    }

    if (!['http:', 'https:'].includes(originalUrl.protocol)) continue;

    originalUrl.hash = '';

    const candidates = buildImageCandidates(originalUrl);
    const normalizedUrl = normalizeWordPressImageUrl(originalUrl);
    const mapKey = `${normalizedUrl.origin}${normalizedUrl.pathname}`;

    if (!downloads.has(mapKey)) {
      const ext = getFileExtension(normalizedUrl);
      const baseName = path.posix.basename(normalizedUrl.pathname, ext);
      const filename = buildImageFilename(baseName, ext, usedFilenames);
      const dataPath = path.join(postImageDataDir, filename);

      if (!argv.dryRun) {
        try {
          const alreadyExists = await fileExists(dataPath);
          let success = true;

          if (!alreadyExists) {
            success = false;
            for (let i = 0; i < candidates.length; i++) {
              const candidateUrl = candidates[i];
              const isLastAttempt = i === candidates.length - 1;
              success = await downloadImage(candidateUrl.href, dataPath, !isLastAttempt);
              if (success) break;
              await fs.rm(dataPath, { force: true });
            }
          }

          if (!success) {
            if (argv.skipMissingMedia) {
              console.error(`    ⚠️  Missing image replaced with placeholder: ${originalUrl.href}`);
              downloads.set(mapKey, '');
            } else {
              console.error(`    ❌ Skipping image due to download failure: ${originalUrl.href}`);
            }
            continue;
          }
        } catch (error) {
          console.error(`    ❌ Failed to persist image asset: ${originalUrl.href}`);
          console.error(error);
          continue;
        }
      }

      downloads.set(mapKey, filename);
    }

    const storedFilename = downloads.get(mapKey);
    if (!storedFilename) {
      if (argv.skipMissingMedia) {
        img.replaceWith(
          `<div class="post__image post__image--missing" role="img" aria-label="Image unavailable">Image unavailable</div>`
        );
      }
      continue;
    }

    img.setAttribute('src', `./_images/${storedFilename}`);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('data-recalc-dims');
    img.removeAttribute('data-src');
    img.removeAttribute('data-lazy-src');
    img.setAttribute('loading', img.getAttribute('loading') ?? 'lazy');
    img.setAttribute('decoding', 'async');

    const existingClass = img.getAttribute('class') ?? '';
    const classes = existingClass.split(/\s+/).filter(Boolean);
    if (!classes.includes('post__image')) {
      classes.push('post__image');
    }
    img.setAttribute('class', classes.join(' ').trim());
  }
}

async function transformPostContent(
  html: string,
  slug: string,
  postImageDataDir: string
): Promise<string> {
  const preparedHtml = preprocessHtml(html);
  const root = parse(preparedHtml);

  normalizeTextareas(root);
  sanitizeUnsupportedNodes(root);
  wrapOrphanTextNodes(root);
  standardizeGalleries(root);
  removeEmptyParagraphs(root);
  convertPseudoLists(root);
  rewriteInternalLinks(root);
  await localizeImages(root, slug, postImageDataDir);

  return decode(root.toString());
}

function transformExcerpt(html: string): string {
  const preparedHtml = preprocessHtml(html);
  const root = parse(preparedHtml);

  sanitizeUnsupportedNodes(root);
  wrapOrphanTextNodes(root);
  removeEmptyParagraphs(root);
  convertPseudoLists(root);
  rewriteInternalLinks(root);

  return decode(root.toString());
}

async function copyImagesToBlog(sourceDir: string, targetDir: string) {
  const entries = await fs.readdir(sourceDir).catch(() => []);

  if (!entries.length) {
    await fs.rm(targetDir, { recursive: true, force: true });
    return;
  }

  await fs.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry);
    const stats = await fs.stat(sourcePath);
    if (!stats.isFile()) continue;
    const destinationPath = path.join(targetDir, entry);
    await fs.copyFile(sourcePath, destinationPath);
  }
}

async function writeMarkdown(postData: PostData, blogDir: string) {
  await fs.mkdir(blogDir, { recursive: true });
  const document = buildMarkdownDocument(postData);
  await fs.writeFile(path.join(blogDir, 'index.md'), document, 'utf8');
}

function buildMarkdownDocument(post: PostData): string {
  const lines: string[] = ['---'];
  lines.push(`layout: "~/layouts/Post.astro"`);
  lines.push(`title: ${JSON.stringify(post.title)}`);
  lines.push(`slug: ${JSON.stringify(post.slug)}`);
  lines.push(`date: ${JSON.stringify(post.date)}`);
  lines.push(`publishedDate: ${JSON.stringify(post.publishedDate)}`);

  if (post.excerpt) {
    const excerpt = cleanExcerpt(post.excerpt);
    if (excerpt) lines.push(`excerpt: ${JSON.stringify(excerpt)}`);
  }

  if (post.featuredImage) {
    lines.push('featuredImage:');
    lines.push(`  src: ${JSON.stringify(post.featuredImage.src)}`);
    if (typeof post.featuredImage.width === 'number') {
      lines.push(`  width: ${post.featuredImage.width}`);
    }
    if (typeof post.featuredImage.height === 'number') {
      lines.push(`  height: ${post.featuredImage.height}`);
    }
    if (post.featuredImage.alt) {
      lines.push(`  alt: ${JSON.stringify(post.featuredImage.alt)}`);
    }
  }

  if (post.categories?.length) {
    lines.push('categories:');
    post.categories.forEach(category => {
      lines.push('  - slug: ' + JSON.stringify(category.slug));
      lines.push('    name: ' + JSON.stringify(category.name));
    });
  } else {
    lines.push('categories: []');
  }

  if (post.tags?.length) {
    lines.push('tags:');
    post.tags.forEach(tag => {
      lines.push('  - slug: ' + JSON.stringify(tag.slug));
      lines.push('    name: ' + JSON.stringify(tag.name));
    });
  } else {
    lines.push('tags: []');
  }

  lines.push('---');

  const frontmatter = lines.join('\n');
  const body = post.content.trim();

  return `${frontmatter}\n\n${body}\n`;
}

function cleanExcerpt(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length ? text : undefined;
}

// Download image with retry
async function downloadImage(url: string, filepath: string, suppressError = false): Promise<boolean> {
  try {
    await retryWithBackoff(async () => {
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: 30000,
      });

      await pipeline(response.data, createWriteStream(filepath));
    });
    return true;
  } catch (error) {
    if (!suppressError) {
      console.error(`    ❌ Failed to download image: ${url}`);
      if (error instanceof AxiosError) {
        console.error(`       Error: ${error.message}`);
      }
    }
    return false;
  }
}

async function persistImageAsset(
  imageUrl: string,
  filename: string,
  dataDir: string,
  suppressError = false
): Promise<boolean> {
  if (argv.dryRun) return true;

  const dataPath = path.join(dataDir, filename);

  try {
    await fs.mkdir(dataDir, { recursive: true });

    const alreadyExists = await fileExists(dataPath);
    let success = true;

    if (!alreadyExists) {
      success = await downloadImage(imageUrl, dataPath, suppressError);
    }

    if (!success) {
      return false;
    }

    return true;
  } catch (error) {
    if (!suppressError) {
      console.error(`    ❌ Failed to persist image asset: ${imageUrl}`);
      console.error(error);
    }
    return false;
  }
}

// Process and save a single post
async function processPost(post: WordPressPost, manifest: ImportManifest): Promise<boolean> {
  const slug = post.slug;
  const date = post.date.split('T')[0].replace(/-/g, ''); // YYYYMMDD
  const publishedDate = post.date.split('T')[0]; // YYYY-MM-DD

  console.log(`  📝 Processing: ${post.title.rendered}`);

  // Prepare directories for this post
  const postDir = path.join(POSTS_BASE_DIR, slug);
  const postImageDataDir = path.join(postDir, 'images');
  const blogPostDir = path.join(BLOG_PAGES_DIR, slug);
  const blogImagesDir = path.join(blogPostDir, '_images');
  if (!argv.dryRun) {
    await fs.rm(postDir, { recursive: true, force: true });
    await fs.rm(blogPostDir, { recursive: true, force: true });
    await fs.mkdir(postDir, { recursive: true });
    await fs.mkdir(postImageDataDir, { recursive: true });
    await fs.mkdir(blogImagesDir, { recursive: true });
  }

  // Download featured image
  let featuredImage: FeaturedImageMeta | undefined;
  const featuredMedia = post._embedded?.['wp:featuredmedia']?.[0];
  if (featuredMedia) {
    const rawUrl =
      featuredMedia.media_details?.sizes?.full?.source_url ??
      featuredMedia.media_details?.sizes?.large?.source_url ??
      featuredMedia.source_url;

    if (rawUrl) {
      try {
        const primaryUrl = new URL(rawUrl, SITE_ORIGIN);
        primaryUrl.search = '';
        const candidates = buildImageCandidates(primaryUrl);
        const normalizedFeatured = candidates[0];
        const ext = getFileExtension(normalizedFeatured);
        const filename = `featured${ext}`;
        let saved = false;

        for (let i = 0; i < candidates.length; i++) {
          const candidateUrl = candidates[i];
          const isLastAttempt = i === candidates.length - 1;
          saved = await persistImageAsset(candidateUrl.href, filename, postImageDataDir, !isLastAttempt);
          if (saved) break;
          if (!isLastAttempt) {
            await fs.rm(path.join(postImageDataDir, filename), { force: true });
          }
        }

        if (saved) {
          featuredImage = {
            src: `./_images/${filename}`,
            width:
              featuredMedia.media_details?.sizes?.full?.width ??
              featuredMedia.media_details?.width,
            height:
              featuredMedia.media_details?.sizes?.full?.height ??
              featuredMedia.media_details?.height,
            alt: featuredMedia.alt_text ? decode(featuredMedia.alt_text) : undefined,
          };
          console.log(`    ✅ Downloaded featured image`);
        } else if (argv.skipMissingMedia) {
          console.error(`    ⚠️  Featured image missing for ${slug}: ${primaryUrl.href}`);
        } else {
          console.error(`    ❌ Failed to download featured image: ${primaryUrl.href}`);
        }
      } catch (error) {
        console.error(`    ❌ Failed to process featured image URL for post ${slug}`);
        console.error(error);
      }
    }
  }

  // Extract categories and tags
  const categories =
    (post._embedded?.['wp:term']?.[0] ?? [])
      .map(t => ({
        id: t.id,
        name: decode(t.name),
        slug: t.slug,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  const tags =
    (post._embedded?.['wp:term']?.[1] ?? [])
      .map(t => ({
        id: t.id,
        name: decode(t.name),
        slug: t.slug,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));

  // Clean content
  const content = await transformPostContent(post.content.rendered, slug, postImageDataDir);
  const excerpt = post.excerpt?.rendered ? transformExcerpt(post.excerpt.rendered) : undefined;

  // Create post data
  const postData: PostData = {
    title: decode(post.title.rendered),
    slug,
    date,
    publishedDate,
    excerpt,
    content,
    featuredImage,
    categories,
    tags,
  };

  if (!argv.dryRun) {
    await fs.writeFile(path.join(postDir, 'wordpress.json'), JSON.stringify(post, null, 2));
    await fs.writeFile(path.join(postDir, 'post.json'), JSON.stringify(postData, null, 2));
    await copyImagesToBlog(postImageDataDir, blogImagesDir);
    await writeMarkdown(postData, blogPostDir);
    if (!manifest.importedPosts.includes(slug)) {
      manifest.importedPosts.push(slug);
    }
  }

  console.log(`    ✅ Generated markdown: src/pages/blog/${slug}/index.md`);
  return true;
}

// Fetch posts from a single page
async function fetchPage(page: number): Promise<{ posts: WordPressPost[]; totalPages: number; totalPosts: number }> {
  const url = `${WP_API_BASE}/posts`;
  const params = {
    page,
    per_page: POSTS_PER_PAGE,
    _embed: '',
  };

  const response = await retryWithBackoff(async () => {
    return await axios.get<WordPressPost[]>(url, { params, timeout: 30000 });
  });

  const totalPages = parseInt(response.headers['x-wp-totalpages'] || '1', 10);
  const totalPosts = parseInt(response.headers['x-wp-total'] || '0', 10);

  return {
    posts: response.data,
    totalPages,
    totalPosts,
  };
}

// Main import function
async function importWordPress() {
  console.log('\n🚀 WordPress to Astro Import Tool\n');
  console.log(`Mode: ${argv.dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  await ensureDirectories();
  const manifest = await loadManifest();

  const startPage = argv.startPage || manifest.lastCompletedPage + 1;
  console.log(`📄 Starting from page ${startPage}\n`);

  try {
    // Fetch first page to get total count
    console.log(`\n📥 Fetching page 1 to get total count...`);
    const { totalPages, totalPosts } = await fetchPage(1);
    manifest.totalPosts = totalPosts;

    console.log(`\n📊 Found ${totalPosts} posts across ${totalPages} pages\n`);

    const maxPages = argv.maxPages ? Math.min(argv.maxPages + startPage - 1, totalPages) : totalPages;

    // Fetch and process each page
    for (let page = startPage; page <= maxPages; page++) {
      console.log(`\n📄 Page ${page} of ${maxPages}`);
      console.log('─'.repeat(50));

      try {
        const { posts } = await fetchPage(page);

        for (const post of posts) {
          await processPost(post, manifest);
        }

        manifest.lastCompletedPage = page;
        manifest.lastRun = new Date().toISOString();
        await saveManifest(manifest);

        // Rate limiting - be nice to the server
        if (page < maxPages) {
          await sleep(500);
        }
      } catch (error) {
        console.error(`\n❌ Error processing page ${page}:`, error);
        console.log(`\n💾 Progress saved. You can resume from page ${page} with:`);
        console.log(`   npm run tool:import-wordpress -- --start-page=${page}\n`);
        throw error;
      }
    }

    console.log('\n' + '═'.repeat(50));
    console.log('✅ Import completed successfully!');
    console.log('═'.repeat(50));
    console.log(`\n📊 Summary:`);
    console.log(`   Total posts: ${manifest.totalPosts}`);
    console.log(`   Imported: ${manifest.importedPosts.length}`);
    console.log(`   Location: ${POSTS_BASE_DIR}\n`);

  } catch (error) {
    console.error('\n❌ Import failed:', error);
    process.exit(1);
  }
}

// Run the import
importWordPress();
