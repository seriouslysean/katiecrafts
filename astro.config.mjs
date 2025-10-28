// @ts-check
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

const BLOG_PAGES_DIR = path.resolve('src/pages/blog');

const blogImagesPlugin = createBlogImagesPlugin(BLOG_PAGES_DIR);
const blogImagesIntegration = createBlogImagesIntegration(BLOG_PAGES_DIR);

// https://astro.build/config
export default defineConfig({
  site: 'https://www.katiecrafts.com',
  output: 'static',
  trailingSlash: 'always',
  build: {
    inlineStylesheets: 'always',
  },
  vite: {
    resolve: {
      alias: {
        '~': '/src',
        '~components': '/src/components',
        '~layouts': '/src/layouts',
        '~utils': '/src/utils',
        '~styles': '/src/styles',
        '~data': '/data',
        '~types': '/types',
        '~tools': '/tools',
      },
    },
    plugins: [blogImagesPlugin],
  },
  integrations: [
    sitemap({
      lastmod: new Date(),
    }),
    blogImagesIntegration,
  ],
});

function createBlogImagesPlugin(blogRoot) {
  return {
    name: 'blog-images-serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (!req.url) return next();
          const url = new URL(req.url, 'http://localhost');
          const pathname = decodeURIComponent(url.pathname);
          const prefix = '/blog/';
          if (!pathname.startsWith(prefix)) return next();
          const imagesMarker = '/_images/';
          const markerIndex = pathname.indexOf(imagesMarker, prefix.length);
          if (markerIndex === -1) return next();
          const slugPart = pathname.slice(prefix.length, markerIndex);
          const imagePart = pathname.slice(markerIndex + imagesMarker.length);
          if (!slugPart || !imagePart) return next();

          const filePath = path.join(blogRoot, ...slugPart.split('/'), '_images', imagePart);
          const stat = await fsp.stat(filePath).catch(() => null);
          if (!stat || !stat.isFile()) return next();

          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Content-Type', getMimeType(filePath));
          fs.createReadStream(filePath).pipe(res);
        } catch (error) {
          next();
        }
      });
    },
  };
}

function createBlogImagesIntegration(blogRoot) {
  return {
    name: 'blog-images-copy',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const outDir = fileURLToPath(dir);
        const imageDirs = await findImageDirectories(blogRoot);
        await Promise.all(
          imageDirs.map(async ({ source, slugSegments }) => {
            const destination = path.join(outDir, 'blog', ...slugSegments, '_images');
            await fsp.mkdir(destination, { recursive: true });
            await fsp.cp(source, destination, { recursive: true });
          })
        );
      },
    },
  };
}

async function findImageDirectories(root) {
  const results = [];
  await walk(root, []);
  return results;

  async function walk(currentDir, slugSegments) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '_images') {
        results.push({
          source: path.join(currentDir, entry.name),
          slugSegments,
        });
        continue;
      }
      await walk(path.join(currentDir, entry.name), [...slugSegments, entry.name]);
    }
  }
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}
