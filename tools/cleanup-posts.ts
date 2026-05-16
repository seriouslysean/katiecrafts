#!/usr/bin/env -S tsx

import fs from 'node:fs';
import path from 'node:path';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, Text, Parent, Properties, ElementContent } from 'hast';
import type { Node } from 'unist';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

interface Options {
  replaceRemoteImages: boolean;
}

const KNOWN_SHORTCODES = [/\[kc-adswap[^\]]*\]/gi, /\[\s*\]/g];
const ALIGN_CLASSES = new Set(['aligncenter', 'alignleft', 'alignright', 'alignnone']);
const WORDPRESS_CLASS_PREFIX = /^wp-/;

const argv = await yargs(hideBin(process.argv))
  .option('slug', {
    type: 'array',
    string: true,
    description: 'Process only the provided post slugs (comma separated or repeated)',
  })
  .option('all', {
    type: 'boolean',
    default: false,
    description: 'Process every post under data/posts',
  })
  .option('replace-remote-images', {
    type: 'boolean',
    default: true,
    description: 'Replace remote images with a placeholder figure',
  })
  .parse();

const postsRoot = path.join(process.cwd(), 'data', 'posts');

const slugs: string[] = collectSlugs({
  all: argv.all,
  slugOption: argv.slug,
  root: postsRoot,
});

if (!slugs.length) {
  console.error('⚠️  No posts found to clean. Provide --slug <slug> or use --all.');
  process.exit(1);
}

for (const slug of slugs) {
  const postPath = path.join(process.cwd(), 'data', 'posts', slug, 'post.json');
  if (!fs.existsSync(postPath)) {
    console.error(`⚠️  Skipping ${slug}: post.json not found`);
    continue;
  }

  const raw = fs.readFileSync(postPath, 'utf8');
  const json = JSON.parse(raw) as { content: string };

  let html = json.content ?? '';
  KNOWN_SHORTCODES.forEach(pattern => {
    html = html.replace(pattern, '');
  });

  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(cleanupPlugin, { replaceRemoteImages: argv['replace-remote-images'] })
    .use(rehypeStringify, { allowDangerousHtml: true });

  const result = await processor.process(html);
  const cleaned = String(result).trim();

  json.content = cleaned;
  fs.writeFileSync(postPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`✅ Cleaned ${slug}`);
}

function collectSlugs({
  all,
  slugOption,
  root,
}: {
  all: boolean;
  slugOption: unknown;
  root: string;
}): string[] {
  if (all) {
    if (!fs.existsSync(root)) return [];
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    } catch (error) {
      console.error('❌ Failed to read posts directory:', error);
      return [];
    }
  }

  if (!slugOption) {
    return [];
  }

  return ([] as string[])
    .concat(slugOption as string[])
    .flatMap(entry => entry.split(','))
    .map(entry => entry.trim())
    .filter(Boolean);
}

function cleanupPlugin(options: Options) {
  return (tree: Root) => {
    normalizeTextNodes(tree);
    unwrapRedundantDivs(tree);
    sanitizeElements(tree, options);
    transformCaptions(tree, options);
    flattenTables(tree);
    flattenDefinitionLists(tree);
    transformTextareas(tree);
    unwrapRedundantDivs(tree); // run again after transformations
    normalizeHeadingsAndLinks(tree);
    unwrapStrongParagraphs(tree);
    replaceRemoteImages(tree, options);
    normalizeBlockquotes(tree);
    removeEmptyElements(tree);
  };
}

function normalizeTextNodes(tree: Root) {
  visit(tree, 'text', (node: Text) => {
    node.value = node.value
      .replace(/\u00A0|&nbsp;/g, ' ')
      .replace(/\s+/g, match => (match.includes('\n') ? match : ' '));
  });
}

function unwrapRedundantDivs(tree: Root | { type: 'root'; children: ElementContent[] }) {
  const allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'a', 'strong', 'em', 'figure']);
  visit(tree as Root, 'element', (node: Element, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.tagName !== 'div') return;

    const meaningful = node.children.filter(child => {
      if (child.type === 'text') return child.value.trim().length > 0;
      if (child.type === 'element') return true;
      return false;
    });
    if (meaningful.length !== 1) return;

    const child = meaningful[0];
    if (child.type === 'element' && allowed.has(child.tagName)) {
      (parent as Parent).children.splice(index, 1, ...(node.children as ElementContent[] as Parent['children']));
      return [SKIP, index];
    }
  });
}

function sanitizeElements(tree: Root, options: Options) {
  visit(tree, 'element', (node: Element) => {
    const properties = (node.properties ??= {});
    if (properties.style) {
      delete properties.style;
    }

    if (properties.className) {
      const classes = toClassList(properties.className);
      const filtered = classes.filter(cls => !ALIGN_CLASSES.has(cls) && !WORDPRESS_CLASS_PREFIX.test(cls));
      properties.className = filtered.length ? filtered : undefined;
    }

    if (node.tagName === 'img' && node.properties) {
      if (!node.properties.alt) node.properties.alt = '';
      delete node.properties.loading;
      delete node.properties.decoding;
    }
  });
}

function transformCaptions(tree: Root, options: Options) {
  visit(tree, 'element', (node: Element, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.tagName !== 'figure') return;

    const classList = toClassList(node.properties?.className);
    const isWpCaption = classList.some(cls => cls === 'wp-caption');
    if (!isWpCaption) return;

    const img = node.children.find(child => child.type === 'element' && child.tagName === 'img') as Element | undefined;
    const figcaption =
      (node.children.find(child => child.type === 'element' && child.tagName === 'figcaption') as Element | undefined) ??
      (node.children.find(
        child =>
          child.type === 'element' &&
          toClassList(child.properties?.className).some(cls => cls === 'wp-caption-text')
      ) as Element | undefined);

    const newFigure: Element = {
      type: 'element',
      tagName: 'figure',
      properties: { className: ['post__figure'] },
      children: [],
    };

    if (img) {
      const processed = sanitizeImage(img, options);
      if (processed) {
        newFigure.children.push(processed);
      }
    }

    if (figcaption) {
      figcaption.tagName = 'figcaption';
      figcaption.properties = { className: ['post__caption'] };
      newFigure.children.push(figcaption);
    }

    if (!newFigure.children.length) {
      parent.children.splice(index, 1);
    } else {
      parent.children.splice(index, 1, newFigure);
    }
    return [SKIP, index];
  });
}

function sanitizeImage(img: Element, options: Options): Element | null {
  const properties = (img.properties ??= {});
  if (properties.style) delete properties.style;
  if (properties.className) {
    const filtered = toClassList(properties.className).filter(cls => !WORDPRESS_CLASS_PREFIX.test(cls));
    properties.className = filtered.length ? filtered : undefined;
  }
  if (options.replaceRemoteImages && properties.src && /^https?:\/\//i.test(String(properties.src))) {
    return createPlaceholderImageBlock();
  }
  if (!properties.alt) properties.alt = '';
  properties.loading = 'lazy';
  properties.decoding = 'async';
  return img;
}

function flattenTables(tree: Root) {
  visit(tree, 'element', (node: Element, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.tagName !== 'table') return;

    const paragraphNodes: Element[] = [];
    node.children.forEach(row => {
      if (row.type !== 'element' || row.tagName !== 'tr') return;
      const text = extractText(row).trim();
      if (!text) return;
      paragraphNodes.push(createParagraph(text));
    });

    if (paragraphNodes.length) {
      parent.children.splice(index, 1, ...paragraphNodes);
    } else {
      parent.children.splice(index, 1);
    }
    return [SKIP, index];
  });
}

function transformTextareas(tree: Root) {
  visit(tree, 'element', (node: Element, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.tagName !== 'textarea') return;

    const text = extractText(node);
    const urls = Array.from(new Set(text.match(/https?:\/\/[^\s"'<>]+/g) ?? []));
    if (!urls.length) {
      parent.children.splice(index, 1);
      return [SKIP, index];
    }

    const replacements = urls.map(url => createLinkParagraph(url, url));
    parent.children.splice(index, 1, ...replacements);
    return [SKIP, index];
  });
}

function flattenDefinitionLists(tree: Root) {
  visit(tree, 'element', (node: Element, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.tagName !== 'dl') return;

    const paragraphs: Element[] = [];
    node.children.forEach(child => {
      if (child.type !== 'element') return;
      if (!['dt', 'dd'].includes(child.tagName)) return;
      const text = extractText(child).trim();
      if (!text.length) return;
      paragraphs.push(createParagraph(text));
    });

    if (paragraphs.length) {
      parent.children.splice(index, 1, ...paragraphs);
    } else {
      parent.children.splice(index, 1);
    }

    return [SKIP, index];
  });
}

function replaceRemoteImages(tree: Root, options: Options) {
  if (!options.replaceRemoteImages) return;
  visit(tree, 'element', (node: Element, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.tagName !== 'img') return;
    const src = String((node.properties?.src ?? '') || '');
    if (!src) return;
    if (!/^https?:\/\//i.test(src)) return;
    const parentEl = parent as Element;
    if (parentEl.type === 'element' && parentEl.tagName === 'figure') {
      parent.children.splice(index, 1, createPlaceholderImageBlock());
    } else if (parentEl.type === 'element' && parentEl.tagName === 'a') {
      parent.children.splice(index, 1, createPlaceholderImageBlock());
    } else {
      parent.children.splice(index, 1, createPlaceholderFigure());
    }
    return [SKIP, index];
  });
}

function normalizeHeadingsAndLinks(tree: Root) {
  const targetTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a']);
  visit(tree, 'element', (node: Element) => {
    if (!targetTags.has(node.tagName)) return;
    node.children = node.children.flatMap<ElementContent>(child => {
      if (child.type === 'element' && child.tagName === 'p') {
        return child.children;
      }
      return [child];
    });
  });
}

function normalizeBlockquotes(tree: Root) {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'blockquote') return;
    unwrapRedundantDivs({ type: 'root', children: node.children });
  });
}

function removeEmptyElements(tree: Root) {
  const keepTags = new Set(['img', 'br', 'figure']);
  visit(tree, 'element', (node: Element, index, parent) => {
    if (!parent || index === undefined) return;
    if (keepTags.has(node.tagName)) return;

    const hasMeaningful = node.children.some(child => {
      if (child.type === 'text') return child.value.trim().length > 0;
      if (child.type === 'element') return true;
      return false;
    });

    if (!hasMeaningful) {
      parent.children.splice(index, 1);
      return [SKIP, index];
    }
  });
}

function unwrapStrongParagraphs(tree: Root) {
  visit(tree, 'element', (node: Element) => {
    if (node.tagName !== 'p') return;
    const meaningful = node.children.filter(child => {
      if (child.type === 'text') return child.value.trim().length > 0;
      if (child.type === 'element') return true;
      return false;
    });
    if (meaningful.length !== 1) return;
    const onlyChild = meaningful[0];
    if (onlyChild.type === 'element' && onlyChild.tagName === 'strong') {
      node.children = onlyChild.children.map(child => ({ ...child }));
    }
  });
}

function extractText(node: Node): string {
  if (node.type === 'text') return (node as Text).value;
  if (node.type === 'element') {
    return (node as Element).children.map(extractText).join('');
  }
  return '';
}

function createParagraph(text: string): Element {
  return {
    type: 'element',
    tagName: 'p',
    properties: {},
    children: [{ type: 'text', value: text }],
  };
}

function createLinkParagraph(url: string, label: string): Element {
  return {
    type: 'element',
    tagName: 'p',
    properties: { className: ['post__embed-link'] },
    children: [
      {
        type: 'element',
        tagName: 'a',
        properties: {
          href: url,
          target: '_blank',
          rel: ['noopener', 'noreferrer'],
        },
        children: [{ type: 'text', value: label }],
      },
    ],
  };
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
  };
}

function createPlaceholderFigure(): Element {
  return {
    type: 'element',
    tagName: 'figure',
    properties: { className: ['post__image', 'post__image--missing'] },
    children: [createPlaceholderImageBlock()],
  };
}

function toClassList(value: Properties['className']): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/\\s+/).filter(Boolean);
  return [String(value)];
}
