import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { sortByPublishedDate } from '~utils/taxonomy';

export async function GET(context: APIContext) {
  const posts = sortByPublishedDate(await getCollection('blog')).slice(0, 50);

  return rss({
    title: 'Katie Crafts',
    description: 'Handmade inspiration, DIY projects, and creative living from Katie Crafts.',
    site: context.site ?? 'https://www.katiecrafts.com',
    items: posts.map(post => ({
      title: post.data.title,
      link: `/blog/${post.id}/`,
      pubDate: new Date(`${post.data.publishedDate}T00:00:00Z`),
      description: post.data.excerpt ?? '',
      categories: [
        ...post.data.categories.map(c => c.name),
        ...post.data.tags.map(t => t.name),
      ],
    })),
  });
}
