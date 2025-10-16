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
import { parse, HTMLElement } from 'node-html-parser';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { WordPressPost, PostData, FeaturedImageMeta } from '~types/post';

// Configuration
const SITE_ORIGIN = 'https://www.katiecrafts.com';
const WP_API_BASE = `${SITE_ORIGIN}/wp-json/wp/v2`;
const POSTS_PER_PAGE = 6;
const DATA_DIR = path.join(process.cwd(), 'data');
const POSTS_BASE_DIR = path.join(DATA_DIR, 'posts');
const PUBLIC_POSTS_DIR = path.join(process.cwd(), 'public', 'posts');
const MANIFEST_FILE = path.join(DATA_DIR, 'import-manifest.json');
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // ms
const INTERNAL_HOSTNAMES = new Set(['www.katiecrafts.com', 'katiecrafts.com']);
const WORDPRESS_CDN_HOSTS = new Set(['i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'i3.wp.com']);

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

function buildImageFilename(baseName: string, index: number, ext: string): string {
  const sanitized = sanitizeFilenameSegment(baseName);
  const prefix = sanitized || 'image';
  return `${prefix}-${index}${ext}`;
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
  await fs.mkdir(PUBLIC_POSTS_DIR, { recursive: true });
}

function preprocessHtml(html: string): string {
  return html.replace(/<!--more-->/g, '');
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
  postImageDataDir: string,
  postImagePublicDir: string
): Promise<void> {
  const downloads = new Map<string, string>();
  let imageIndex = 1;

  for (const img of root.querySelectorAll('img')) {
    const sourceAttr =
      img.getAttribute('data-src') ??
      img.getAttribute('data-lazy-src') ??
      img.getAttribute('src');

    if (!sourceAttr) continue;

    let imageUrl: URL;
    try {
      imageUrl = new URL(sourceAttr, SITE_ORIGIN);
    } catch {
      continue;
    }

    if (!['http:', 'https:'].includes(imageUrl.protocol)) continue;

    if (WORDPRESS_CDN_HOSTS.has(imageUrl.hostname)) {
      imageUrl.search = '';
    }
    imageUrl.hash = '';

    const mapKey = `${imageUrl.origin}${imageUrl.pathname}`;

    if (!downloads.has(mapKey)) {
      const ext = getFileExtension(imageUrl);
      const baseName = path.basename(imageUrl.pathname, ext);
      const filename = buildImageFilename(baseName, imageIndex, ext);
      const dataPath = path.join(postImageDataDir, filename);
      const publicPath = path.join(postImagePublicDir, filename);

      if (!argv.dryRun) {
        try {
          const alreadyExists = await fileExists(dataPath);
          let success = true;

          if (!alreadyExists) {
            success = await downloadImage(imageUrl.href, dataPath);
          }

          if (!success) {
            console.error(`    ❌ Skipping image due to download failure: ${imageUrl.href}`);
            continue;
          }

          await fs.copyFile(dataPath, publicPath);
        } catch (error) {
          console.error(`    ❌ Failed to copy image to public directory: ${imageUrl.href}`);
          console.error(error);
          continue;
        }
      }

      downloads.set(mapKey, filename);
      imageIndex += 1;
    }

    const storedFilename = downloads.get(mapKey);
    if (!storedFilename) continue;

    img.setAttribute('src', `/posts/${slug}/${storedFilename}`);
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
  postImageDataDir: string,
  postImagePublicDir: string
): Promise<string> {
  const preparedHtml = preprocessHtml(html);
  const root = parse(preparedHtml);

  standardizeGalleries(root);
  removeEmptyParagraphs(root);
  convertPseudoLists(root);
  rewriteInternalLinks(root);
  await localizeImages(root, slug, postImageDataDir, postImagePublicDir);

  return decode(root.toString());
}

function transformExcerpt(html: string): string {
  const preparedHtml = preprocessHtml(html);
  const root = parse(preparedHtml);

  removeEmptyParagraphs(root);
  convertPseudoLists(root);
  rewriteInternalLinks(root);

  return decode(root.toString());
}

// Download image with retry
async function downloadImage(url: string, filepath: string): Promise<boolean> {
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
    console.error(`    ❌ Failed to download image: ${url}`);
    if (error instanceof AxiosError) {
      console.error(`       Error: ${error.message}`);
    }
    return false;
  }
}

async function persistImageAsset(
  imageUrl: string,
  filename: string,
  dataDir: string,
  publicDir: string
): Promise<boolean> {
  if (argv.dryRun) return true;

  const dataPath = path.join(dataDir, filename);
  const publicPath = path.join(publicDir, filename);

  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(publicDir, { recursive: true });

    const alreadyExists = await fileExists(dataPath);
    let success = true;

    if (!alreadyExists) {
      success = await downloadImage(imageUrl, dataPath);
    }

    if (!success) {
      return false;
    }

    await fs.copyFile(dataPath, publicPath);
    return true;
  } catch (error) {
    console.error(`    ❌ Failed to persist image asset: ${imageUrl}`);
    console.error(error);
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
  const postImagePublicDir = path.join(PUBLIC_POSTS_DIR, slug);
  if (!argv.dryRun) {
    await fs.rm(postDir, { recursive: true, force: true });
    await fs.rm(postImagePublicDir, { recursive: true, force: true });
    await fs.mkdir(postDir, { recursive: true });
    await fs.mkdir(postImageDataDir, { recursive: true });
    await fs.mkdir(postImagePublicDir, { recursive: true });
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
        const featuredUrl = new URL(rawUrl, SITE_ORIGIN);
        featuredUrl.search = '';
        const ext = getFileExtension(featuredUrl);
        const filename = `featured${ext}`;
        const saved = await persistImageAsset(
          featuredUrl.href,
          filename,
          postImageDataDir,
          postImagePublicDir
        );

        if (saved) {
          featuredImage = {
            src: `/posts/${slug}/${filename}`,
            width:
              featuredMedia.media_details?.sizes?.full?.width ??
              featuredMedia.media_details?.width,
            height:
              featuredMedia.media_details?.sizes?.full?.height ??
              featuredMedia.media_details?.height,
            alt: featuredMedia.alt_text ? decode(featuredMedia.alt_text) : undefined,
          };
          console.log(`    ✅ Downloaded featured image`);
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
  const content = await transformPostContent(
    post.content.rendered,
    slug,
    postImageDataDir,
    postImagePublicDir
  );
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

  // Save post JSON
  const filepath = path.join(postDir, 'post.json');

  if (!argv.dryRun) {
    await fs.writeFile(filepath, JSON.stringify(postData, null, 2));
    if (!manifest.importedPosts.includes(slug)) {
      manifest.importedPosts.push(slug);
    }
  }

  console.log(`    ✅ Saved: ${slug}/post.json`);
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
