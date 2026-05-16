#!/usr/bin/env -S tsx

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { scrubAltText } from './lib/scrub-wp-urls.ts';

interface PostData {
  title: string;
  slug: string;
  date: string;
  publishedDate: string;
  excerpt?: string;
  featuredImage?: {
    src: string;
    width?: number;
    height?: number;
    alt?: string;
  };
  categories: { slug: string; name: string }[];
  tags: { slug: string; name: string }[];
  content: string;
}

const argv = await yargs(hideBin(process.argv))
  .option('slug', {
    type: 'array',
    string: true,
    description: 'Post slugs to export (comma separated or repeated). If omitted, export all.',
  })
  .option('out', {
    type: 'string',
    default: path.join(process.cwd(), 'src', 'content', 'blog'),
    description: 'Directory to write blog content collection entries into',
  })
  .option('data', {
    type: 'string',
    default: path.join(process.cwd(), 'data', 'posts'),
    description: 'Source directory containing post JSON + images',
  })
  .parse();

const outputRoot = path.resolve(argv.out);
const legacyPublicPostsDir = path.join(process.cwd(), 'public', 'posts');
const legacyPublicBlogDir = path.join(process.cwd(), 'public', 'blog');
const dataRoot = path.resolve(argv.data);

const MARKDOWN_IMAGE_PATTERN = /(!\[[^\]]*\]\()([^)\s]+)(\s+"[^"]*")?(\))/g;
const HTML_IMG_SRC_PATTERN = /(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi;

const selectedSlugs: string[] = argv.slug
  ? ([] as string[])
      .concat(argv.slug as string[])
      .flatMap(entry => entry.split(','))
      .map(entry => entry.trim())
      .filter(Boolean)
  : await listSlugs(dataRoot);

if (!selectedSlugs.length) {
  console.error('⚠️  No slugs found to export.');
  process.exit(1);
}

await fs.mkdir(outputRoot, { recursive: true });
const slugSet = new Set(selectedSlugs);

const removedLegacyDirs = await Promise.all([
  removeDirectoryIfExists(legacyPublicPostsDir),
  removeDirectoryIfExists(legacyPublicBlogDir),
]);

if (removedLegacyDirs.some(Boolean)) {
  console.log('🧹 Removed legacy public assets (public/posts, public/blog)');
}

await pruneExtraneousDirs(outputRoot, slugSet, { reserved: new Set(['page']) });

for (const slug of selectedSlugs) {
  try {
    await exportPost(slug);
    console.log(`✅ Exported ${slug}`);
  } catch (error) {
    console.error(`❌ Failed to export ${slug}:`, error);
  }
}

async function listSlugs(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

async function exportPost(slug: string) {
  const postDir = path.join(dataRoot, slug);
  const jsonPath = path.join(postDir, 'post.json');
  const imagesDir = path.join(postDir, 'images');

  const jsonRaw = await fs.readFile(jsonPath, 'utf8');
  const post = JSON.parse(jsonRaw) as PostData;

  const imageEntries = await fs
    .readdir(imagesDir)
    .catch(() => [] as string[]);
  const imageFiles: string[] = [];
  for (const file of imageEntries) {
    const stat = await fs.stat(path.join(imagesDir, file)).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) continue;
    imageFiles.push(file);
  }
  const imageMaps = createImageMaps(imageFiles);

  const { content, ...frontmatter } = post;
  const body = rewriteBodyImages(stripLeadingTitle(content, post.title), imageMaps);

  const targetDir = path.join(outputRoot, slug);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  await copyImages(imagesDir, targetDir, imageMaps);

  const frontmatterLines = buildFrontmatter(frontmatter, imageMaps);
  const markdown = `${frontmatterLines}\n\n${body}\n`;
  await fs.writeFile(path.join(targetDir, 'index.md'), markdown, 'utf8');
}

async function copyImages(sourceDir: string, targetDir: string, maps: ImageMaps) {
  try {
    const files = await fs.readdir(sourceDir);
    await Promise.all(
      files.map(async file => {
        const sourcePath = path.join(sourceDir, file);
        const stat = await fs.stat(sourcePath).catch(() => null);
        if (!stat || !stat.isFile() || stat.size === 0) return;
        const targetName = maps.fileMap.get(file) ?? file;
        await fs.copyFile(sourcePath, path.join(targetDir, targetName));
      })
    );
  } catch (error: any) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function buildFrontmatter(post: Omit<PostData, 'content'>, maps: ImageMaps): string {
  const lines = ['---'];
  lines.push(`title: ${JSON.stringify(post.title)}`);
  lines.push(`publishedDate: ${JSON.stringify(post.publishedDate)}`);

  if (post.excerpt) {
    const excerpt = cleanExcerpt(post.excerpt);
    if (excerpt) lines.push(`excerpt: ${JSON.stringify(excerpt)}`);
  }

  if (post.featuredImage) {
    const targetName = resolveImageName(post.featuredImage.src, maps);
    if (targetName) {
      lines.push('featuredImage:');
      lines.push(`  src: ${JSON.stringify(`./${targetName}`)}`);
      const altRaw = post.featuredImage.alt;
      if (altRaw) {
        const alt = scrubAltText(altRaw);
        if (alt) lines.push(`  alt: ${JSON.stringify(alt)}`);
      }
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
  return lines.join('\n');
}

function stripLeadingTitle(markdown: string, title?: string): string {
  if (!title || !markdown) return markdown;
  const normalizedTitle = normalizeText(title);
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return markdown;
  const candidate = lines[i].replace(/^#+\s*/, '').trim();
  if (normalizeText(candidate) === normalizedTitle) {
    lines.splice(i, 1);
    while (i < lines.length && lines[i].trim() === '') {
      lines.splice(i, 1);
    }
  }
  return lines.join('\n');
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function rewriteBodyImages(markdown: string, maps: ImageMaps): string {
  if (!markdown) return markdown;

  let result = markdown.replace(MARKDOWN_IMAGE_PATTERN, (match, _prefix, url, _title, _suffix) => {
    const localName = resolveImageName(url, maps);
    if (localName) return `![${extractAlt(match)}](./${localName}${_title ?? ''}${_suffix.replace(/^\)/, ')')}`;
    if (isLocalLookingPath(url)) {
      const alt = extractAlt(match);
      return alt ? alt : '';
    }
    return match;
  });

  result = result.replace(HTML_IMG_SRC_PATTERN, (match, prefix, url, suffix) => {
    const localName = resolveImageName(url, maps);
    if (localName) return `${prefix}./${localName}${suffix}`;
    if (isLocalLookingPath(url)) return '';
    return match;
  });

  return result;
}

function extractAlt(markdownImage: string): string {
  const altMatch = markdownImage.match(/^!\[([^\]]*)\]/);
  return altMatch ? altMatch[1] : '';
}

function isLocalLookingPath(url: string): boolean {
  return url.startsWith('./') || url.startsWith('../') || url.startsWith('/');
}

function basename(src: string): string {
  return src.split('/').pop() ?? src;
}

function cleanExcerpt(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length ? text : undefined;
}

type ImageMaps = {
  fileMap: Map<string, string>;
  canonicalMap: Map<string, string>;
};

function createImageMaps(files: string[]): ImageMaps {
  const fileMap = new Map<string, string>();
  const canonicalMap = new Map<string, string>();

  for (const file of files) {
    fileMap.set(file, file);
    canonicalMap.set(canonicalize(file), file);
  }

  return { fileMap, canonicalMap };
}

function resolveImageName(src: string | undefined, maps: ImageMaps): string | null {
  if (!src) return null;
  const cleanSrc = src.split('?')[0];
  const base = basename(cleanSrc);

  if (maps.fileMap.has(base)) {
    return maps.fileMap.get(base)!;
  }

  const canonical = canonicalize(base);
  if (maps.fileMap.has(canonical)) {
    return maps.fileMap.get(canonical)!;
  }

  if (maps.canonicalMap.has(canonical)) {
    return maps.canonicalMap.get(canonical)!;
  }

  return null;
}

function canonicalize(filename: string): string {
  const ext = path.extname(filename);
  const name = path.basename(filename, ext);
  const stripped = name.replace(/-\d+$/, '');
  return `${stripped}${ext}`;
}

async function pruneExtraneousDirs(
  root: string,
  keepSlugs: Set<string>,
  options: { reserved?: Set<string> } = {}
) {
  const reserved = options.reserved ?? new Set<string>();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const removals = entries
    .filter(entry => entry.isDirectory())
    .filter(entry => !keepSlugs.has(entry.name) && !reserved.has(entry.name));

  await Promise.all(removals.map(entry => fs.rm(path.join(root, entry.name), { recursive: true, force: true })));
}

async function removeDirectoryIfExists(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  await fs.rm(dir, { recursive: true, force: true });
  return true;
}
