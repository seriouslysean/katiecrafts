import type { MarkdownInstance } from 'astro';

export const POSTS_PER_PAGE = 6;
export const HOME_POSTS_LIMIT = 3;

const BLOG_ROUTE_PREFIX = '/blog';

export interface TaxonomySummary {
  slug: string;
  name: string;
  count: number;
}

export interface TaxonomyTerm {
  slug: string;
  name: string;
}

export interface FeaturedImageMeta {
  src: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface PostFrontmatter {
  title: string;
  slug: string;
  date: string;
  publishedDate: string;
  excerpt?: string;
  featuredImage?: FeaturedImageMeta;
  categories: TaxonomyTerm[];
  tags: TaxonomyTerm[];
  layout?: string;
}

export interface PostEntry {
  slug: string;
  url: string;
  data: PostFrontmatter;
}

type MarkdownModule = MarkdownInstance<Record<string, unknown>>;

const publishDateSorter = (a: PostEntry, b: PostEntry) =>
  b.data.publishedDate.localeCompare(a.data.publishedDate);

const markdownModules = import.meta.glob('../pages/blog/**/index.md', {
  eager: true,
}) as Record<string, MarkdownModule>;

const allPosts = loadMarkdownPosts(markdownModules);

export async function getAllPosts(): Promise<PostEntry[]> {
  return [...allPosts];
}

export function getPostSlug(post: PostEntry): string {
  return post.slug;
}

export function getPostUrl(post: PostEntry): string {
  return post.url;
}

export function paginatePosts(posts: PostEntry[], page: number, pageSize = POSTS_PER_PAGE) {
  const totalPages = Math.max(1, Math.ceil(posts.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;

  return {
    posts: posts.slice(start, end),
    currentPage,
    totalPages,
  };
}

export function findPostBySlug(posts: PostEntry[], slug: string) {
  return posts.find(post => post.slug === slug);
}

export function formatPublishedDate(isoDate: string, locale = 'en-US') {
  if (!isoDate) return '';
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }

  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

type TaxonomyKey = 'categories' | 'tags';

export function getPostFeaturedImage(post: PostEntry) {
  const image = post.data.featuredImage;
  if (!image) return undefined;

  return {
    ...image,
    src: resolveImageSrc(image.src, post.slug),
  };
}

export function getCategorySummaries(posts: PostEntry[]): TaxonomySummary[] {
  return buildTaxonomySummary(posts, 'categories');
}

export function getTagSummaries(posts: PostEntry[]): TaxonomySummary[] {
  return buildTaxonomySummary(posts, 'tags');
}

export function getPostsByCategory(posts: PostEntry[], slug: string): PostEntry[] {
  return filterPostsByTaxonomy(posts, 'categories', slug);
}

export function getPostsByTag(posts: PostEntry[], slug: string): PostEntry[] {
  return filterPostsByTaxonomy(posts, 'tags', slug);
}

function loadMarkdownPosts(modules: Record<string, MarkdownModule>): PostEntry[] {
  const entries: PostEntry[] = [];

  for (const [filepath, module] of Object.entries(modules)) {
    const slug = extractSlug(filepath);
    const frontmatter = (module.frontmatter ?? {}) as Record<string, unknown>;
    const data = normalizeFrontmatter(frontmatter, slug);

    entries.push({
      slug,
      url: `${BLOG_ROUTE_PREFIX}/${slug}/`,
      data,
    });
  }

  return entries.sort(publishDateSorter);
}

function extractSlug(filepath: string): string {
  const normalized = filepath.replace(/\\/g, '/');
  const match = normalized.match(/\/pages\/blog\/(.+)\/index\.md$/);
  if (!match) {
    throw new Error(`Unable to derive slug from path: ${filepath}`);
  }
  return match[1];
}

function normalizeFrontmatter(frontmatter: Record<string, unknown>, slug: string): PostFrontmatter {
  const publishedDate = normalizePublishedDate(frontmatter.publishedDate, frontmatter.date);
  const date = normalizeDate(frontmatter.date, publishedDate);

  return {
    title: ensureString(frontmatter.title, humanizeSlug(slug)),
    slug,
    date,
    publishedDate,
    excerpt: ensureOptionalString(frontmatter.excerpt),
    featuredImage: normalizeFeaturedImage(frontmatter.featuredImage, slug),
    categories: normalizeTaxonomy(frontmatter.categories),
    tags: normalizeTaxonomy(frontmatter.tags),
    layout: typeof frontmatter.layout === 'string' ? frontmatter.layout : undefined,
  };
}

function ensureString(value: unknown, fallback = ''): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallback;
}

function ensureOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  return undefined;
}

function normalizeDate(value: unknown, publishedDate: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (publishedDate) {
    return publishedDate.replace(/-/g, '');
  }
  return '';
}

function normalizePublishedDate(value: unknown, fallback: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    const trimmed = fallback.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    if (/^\d{8}$/.test(trimmed)) {
      return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6)}`;
    }
  }
  return '';
}

function normalizeFeaturedImage(value: unknown, slug: string): FeaturedImageMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const rawSrc = ensureString(candidate.src, '');
  if (!rawSrc) return undefined;

  return {
    src: resolveImageSrc(rawSrc, slug),
    width: typeof candidate.width === 'number' ? candidate.width : undefined,
    height: typeof candidate.height === 'number' ? candidate.height : undefined,
    alt: ensureOptionalString(candidate.alt),
  };
}

function resolveImageSrc(src: string, slug: string): string {
  if (!src) return src;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith(BLOG_ROUTE_PREFIX)) return src;
  if (src.startsWith('/posts/')) {
    return src.replace(/^\/posts\//, `${BLOG_ROUTE_PREFIX}/`);
  }
  if (src.startsWith('/')) return src;
  const cleaned = src.replace(/^\.\//, '');
  return `${BLOG_ROUTE_PREFIX}/${slug}/${cleaned}`;
}

function normalizeTaxonomy(value: unknown): TaxonomyTerm[] {
  if (!Array.isArray(value)) return [];
  const terms = new Map<string, string>();

  for (const entry of value) {
    if (typeof entry === 'string') {
      const slug = entry.trim();
      if (!slug) continue;
      if (!terms.has(slug)) {
        terms.set(slug, humanizeSlug(slug));
      }
      continue;
    }

    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const rawSlug = record.slug ?? record.name;
      const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
      if (!slug) continue;
      const name =
        typeof record.name === 'string' && record.name.trim()
          ? record.name.trim()
          : humanizeSlug(slug);
      if (!terms.has(slug)) {
        terms.set(slug, name);
      }
    }
  }

  return Array.from(terms.entries()).map(([slug, name]) => ({ slug, name }));
}

function humanizeSlug(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function buildTaxonomySummary(posts: PostEntry[], key: TaxonomyKey): TaxonomySummary[] {
  const counts = new Map<string, { name: string; count: number }>();

  for (const post of posts) {
    for (const term of post.data[key]) {
      const entry = counts.get(term.slug);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(term.slug, { name: term.name, count: 1 });
      }
    }
  }

  return Array.from(counts.entries())
    .map(([slug, value]) => ({
      slug,
      name: value.name,
      count: value.count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterPostsByTaxonomy(posts: PostEntry[], key: TaxonomyKey, slug: string) {
  return posts.filter(post => post.data[key].some(term => term.slug === slug)).sort(publishDateSorter);
}
