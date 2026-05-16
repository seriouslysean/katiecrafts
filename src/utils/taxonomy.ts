import type { CollectionEntry } from 'astro:content';

export type BlogEntry = CollectionEntry<'blog'>;

export interface TaxonomySummary {
  slug: string;
  name: string;
  count: number;
}

type TaxonomyKey = 'categories' | 'tags';

const publishedDateSorter = (a: BlogEntry, b: BlogEntry) =>
  b.data.publishedDate.localeCompare(a.data.publishedDate);

export function sortByPublishedDate(posts: BlogEntry[]): BlogEntry[] {
  return [...posts].sort(publishedDateSorter);
}

export function getCategorySummaries(posts: BlogEntry[]): TaxonomySummary[] {
  return buildTaxonomySummary(posts, 'categories');
}

export function getTagSummaries(posts: BlogEntry[]): TaxonomySummary[] {
  return buildTaxonomySummary(posts, 'tags');
}

export function getPostsByCategory(posts: BlogEntry[], slug: string): BlogEntry[] {
  return filterPostsByTaxonomy(posts, 'categories', slug);
}

export function getPostsByTag(posts: BlogEntry[], slug: string): BlogEntry[] {
  return filterPostsByTaxonomy(posts, 'tags', slug);
}

function buildTaxonomySummary(posts: BlogEntry[], key: TaxonomyKey): TaxonomySummary[] {
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
    .map(([slug, value]) => ({ slug, name: value.name, count: value.count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterPostsByTaxonomy(posts: BlogEntry[], key: TaxonomyKey, slug: string): BlogEntry[] {
  return posts
    .filter(post => post.data[key].some(term => term.slug === slug))
    .sort(publishedDateSorter);
}
