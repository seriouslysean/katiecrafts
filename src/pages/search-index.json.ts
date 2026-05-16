import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const posts = await getCollection('blog');
  const documents = posts.map(post => ({
    id: post.id,
    title: post.data.title,
    excerpt: truncate(post.data.excerpt ?? '', 120),
    categories: post.data.categories.map(c => c.name).join(' '),
    tags: post.data.tags.map(t => t.name).join(' '),
  }));

  return new Response(JSON.stringify(documents), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};

function truncate(value: string, max: number): string {
  const stripped = value.replace(/\s+/g, ' ').trim();
  return stripped.length > max ? stripped.slice(0, max).trimEnd() + '…' : stripped;
}
