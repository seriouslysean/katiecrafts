import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.katiecrafts.com',
  output: 'static',
  trailingSlash: 'always',
  // Astro 7 defaults to 'jsx' whitespace handling, which drops the space between
  // inline elements (e.g. category name and post count), so keep 'true'.
  compressHTML: true,
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
        '~tools': '/tools',
      },
    },
  },
  integrations: [
    sitemap({
      lastmod: new Date(),
    }),
  ],
});
