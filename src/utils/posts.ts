import { getCollection, type CollectionEntry } from 'astro:content';

export type PostEntry = CollectionEntry<'posts'>;

export const POSTS_PER_PAGE = 6;
export const HOME_POSTS_LIMIT = 3;

export interface TaxonomySummary {
  slug: string;
  name: string;
  count: number;
}

const publishDateSorter = (a: PostEntry, b: PostEntry) => {
  return b.data.publishedDate.localeCompare(a.data.publishedDate);
};

export async function getAllPosts(): Promise<PostEntry[]> {
  const posts = await getCollection('posts');
  return posts.sort(publishDateSorter);
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
  return posts.find(post => post.data.slug === slug);
}

export function formatPublishedDate(isoDate: string, locale = 'en-US') {
  const date = new Date(isoDate);

  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

type TaxonomyKey = 'categories' | 'tags';

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
