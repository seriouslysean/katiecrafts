import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/index.md', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      publishedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      excerpt: z.string().optional(),
      featuredImage: z
        .object({
          src: image(),
          alt: z.string().optional(),
        })
        .optional(),
      categories: z.array(z.object({ slug: z.string(), name: z.string() })).default([]),
      tags: z.array(z.object({ slug: z.string(), name: z.string() })).default([]),
    }),
});

export const collections = { blog };
