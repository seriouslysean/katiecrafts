import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const taxonomy = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
});

const posts = defineCollection({
  loader: glob({
    pattern: '**/post.json',
    base: './data/posts',
  }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    date: z.string(), // YYYYMMDD format
    publishedDate: z.string(), // YYYY-MM-DD format for display
    excerpt: z.string().optional(),
    content: z.string(), // HTML content
    featuredImage: z
      .object({
        src: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        alt: z.string().optional(),
      })
      .optional(),
    categories: z.array(taxonomy).default([]),
    tags: z.array(taxonomy).default([]),
  }),
});

export const collections = { posts };
