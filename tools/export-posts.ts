#!/usr/bin/env -S tsx

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Element, Properties, Root, Node } from 'hast';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

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
    default: path.join(process.cwd(), 'src', 'pages', 'blog'),
    description: 'Directory to write blog pages into',
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

  const imageFiles = await fs
    .readdir(imagesDir)
    .catch(() => [] as string[]);
  const imageMaps = createImageMaps(imageFiles);

  const { content, ...frontmatter } = post;
  const html = transformContent(content, slug, imageMaps, post.title);

  const targetDir = path.join(outputRoot, slug);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  await copyImages(imagesDir, targetDir, imageMaps);

  const frontmatterLines = buildFrontmatter(frontmatter, imageMaps);
  const markdown = `${frontmatterLines}\n${html}\n`;
  await fs.writeFile(path.join(targetDir, 'index.md'), markdown, 'utf8');
}

async function copyImages(sourceDir: string, targetDir: string, maps: ImageMaps) {
  try {
    const files = await fs.readdir(sourceDir);
    const assetsDir = path.join(targetDir, '_images');
    await fs.rm(assetsDir, { recursive: true, force: true });
    await fs.mkdir(assetsDir, { recursive: true });
    await Promise.all(
      files.map(async file => {
        const targetName = maps.fileMap.get(file) ?? file;
        await fs.copyFile(path.join(sourceDir, file), path.join(assetsDir, targetName));
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
    const targetName = resolveImageName(post.featuredImage.src, maps);
    if (targetName) {
      lines.push('featuredImage:');
      lines.push(`  src: ${JSON.stringify(`./_images/${targetName}`)}`);
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

function transformContent(html: string, slug: string, maps: ImageMaps, title?: string): string {
  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(() => tree => rewriteImageSources(tree, slug, maps))
    .use(() => tree => stripLeadingTitle(tree, title))
    .use(rehypeStringify, { allowDangerousHtml: true });

  const result = processor.processSync(html);
  return result.toString().trim();
}

function rewriteImageSources(tree: any, slug: string, maps: ImageMaps) {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'img') return;
    const properties = (node.properties ??= {});
    if (!properties.src) return;
    const src = String(properties.src);
    const localName = resolveImageName(src, maps);
    if (!localName) {
      const placeholder = createPlaceholderImageBlock();
      node.tagName = placeholder.tagName;
      node.properties = placeholder.properties;
      node.children = placeholder.children;
      return;
    }
    properties.src = `./_images/${localName}`;
    ensureImageClasses(properties);
  });

  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'figure') return;
    const hasImage = node.children.some(child => child.type === 'element' && child.tagName === 'img');
    if (hasImage) {
      node.properties = {
        ...(node.properties ?? {}),
        className: mergeClassLists(node.properties?.className, ['post__figure']),
      };
    }
  });
}

function stripLeadingTitle(tree: Root, title?: string) {
  if (!title) return;
  const normalizedTitle = normalizeText(title);

  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i];
    if (node.type === 'text') {
      if (node.value.trim().length) break;
      tree.children.splice(i, 1);
      i--;
      continue;
    }

    if (node.type === 'element' && node.tagName === 'p') {
      const textContent = normalizeText(extractText(node));
      if (textContent === normalizedTitle) {
        tree.children.splice(i, 1);
      }
    }
    break;
  }
}

function ensureImageClasses(properties: Properties) {
  properties.className = mergeClassLists(properties.className, ['post__image']);
}

function mergeClassLists(value: Properties['className'], extra: string[]): string[] {
  const existing = new Set(toClassList(value));
  extra.forEach(cls => existing.add(cls));
  return Array.from(existing);
}

function createPlaceholderImageBlock(): Element {
  return {
    type: 'element',
    tagName: 'div',
    properties: {
      className: ['post__image', 'post__image--missing'],
      role: 'img',
      ariaLabel: 'Image unavailable',
    },
    children: [{ type: 'text', value: 'Image unavailable' }],
  } as Element;
}

function createPlaceholderFigure(): Element {
  return {
    type: 'element',
    tagName: 'figure',
    properties: { className: ['post__image', 'post__image--missing'] },
    children: [createPlaceholderImageBlock()],
  } as Element;
}

function extractText(node: Node): string {
  if (node.type === 'text') {
    return node.value;
  }
  if (node.type === 'element') {
    return (node.children as Node[]).map(extractText).join('');
  }
  return '';
}

function toClassList(value: Properties['className']): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [String(value)];
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

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
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
