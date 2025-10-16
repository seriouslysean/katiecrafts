// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

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
  },
  integrations: [
    sitemap({
      lastmod: new Date(),
    }),
  ],
});
