#!/usr/bin/env node
/* eslint-disable import/no-extraneous-dependencies */

// Usage from the root directory:
// Run `node ./tools/import.js --url="https://www.domain.com/wp-json/wp/v2/posts?page=1&per_page=1" --save-images=true --loop=true`

const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const argv = yargs(hideBin(process.argv)).argv;
const { get } = require('lodash');
// eslint-disable-next-line import/no-extraneous-dependencies
const axios = require('axios').default;
const { decode } = require('html-entities');
const prettier = require('prettier');
const { parse } = require('node-html-parser');

//////////////////////////////////////////////////
///// SETUP
//////////////////////////////////////////////////

const WPLOOP = argv.loop && argv.loop.toLowerCase() === 'true';
const WPSAVEIMAGES = argv.saveImages && argv.saveImages.toLowerCase() === 'true';

// Check if we have a url, if not exit early
const WPURL = argv.url;
if (!WPURL) {
    logErrorAndExit('wp-json url is required');
}

// If we have a url, we need to verify that page and per_page are set
const WPURL_PARSED = new URL(WPURL);
const PAGE = WPURL_PARSED.searchParams.get('page');
const PER_PAGE = WPURL_PARSED.searchParams.get('per_page');
if (!PAGE || !PER_PAGE) {
    logErrorAndExit(`'page' and 'per_page' query params are required; PAGE: ${PAGE}, PER_PAGE: ${PER_PAGE}`);
}

// &_embed is required to inline content in to the response
WPURL_PARSED.searchParams.append('_embed', '');

//////////////////////////////////////////////////
///// EXPORT
//////////////////////////////////////////////////

function logErrorAndExit(msg) {
    // eslint-disable-next-line no-console
    console.error(msg);
    process.exit(1);
}

function getAdaptedImage(image, imageClass) {
    const src = (image.getAttribute('src') || '').split('?')[0]; // .replace(/\.jpeg$/, '.jpg');
    const alt = image.getAttribute('alt') || '';
    const width = image.getAttribute('width') || '';
    const height = image.getAttribute('height') || '';
    return `<img class="${imageClass}" src="${src}" loading="lazy" alt="${alt}" width="${width}" height="${height}" />`
}

function formatAndSavePost(post) {
    // Get the root domain
    const baseUrl =  WPURL_PARSED.origin;

    // Split data on T to only get YYYY-MM-DD
    const date = post.date.split('T')[0];
    console.log(date);

    // Get the post title
    const title = get(post, 'title.rendered');

    // Get the post content
    const content = get(post, 'content.rendered')
        .replace('<!--more-->', '');
    const contentParsed = parse(content);

    // When using &_embed, linked data is stored in the _embedded object
    const embedded = get(post, '_embedded');

    // Featured image
    const featuredImage = get(embedded, 'wp:featuredmedia.0.media_details.sizes.full');
    console.log(featuredImage);

    if (WPSAVEIMAGES) {
        console.log('!!! Save image');
    }

    // Categories and tags
    const getAndFormatTaxonomy = (slug, taxonomy) => {
        if (!Array.isArray(taxonomy) && !taxonomy.length) {
            return '';
        }
        let output = '\n';
        for (let i = 0; i < taxonomy.length; i += 1) {
            output += `- ${taxonomy[i]}`;
            if (i < taxonomy.length - 1) {
                output += '\n';
            }
        }
        return output;
    };
    const categories =  (get(embedded, 'wp:term.0') || []).map(({ slug }) => slug);
    const tags = (get(embedded, 'wp:term.1') || []).map(({ slug }) => slug);

    // Convert galleries to non wp markup
    const getAndMutateGalleries = (content) => {
        const galleries = content.querySelectorAll('.gallery');
        galleries.forEach((gallery) => {
            // Fix class name of container
            gallery.removeAttribute('id');
            gallery.setAttribute('class', 'post__gallery');

            // Fix the gallery items
            const items = gallery.querySelectorAll('.gallery-item');
            items.forEach((item) => {
                const image = item.querySelector('img');
                if (image) {
                    const imageEl = getAdaptedImage(image, 'post__gallery-image');
                    item.replaceWith(`<div class="post__gallery-item">${imageEl}</div>`);
                }
            });
        });
        return galleries;
    }
    const galleries = getAndMutateGalleries(contentParsed);

    // Convert remaining lazy loaded images to standard images
    const lazyImages = contentParsed.querySelectorAll('img[loading="lazy"]');
    lazyImages.forEach((image) => {
        const imageEl = getAdaptedImage(image, 'post__image');
        image.replaceWith(imageEl);
    });

    // Post images
    // TODO

    // Frontmatter meta information
    const frontMatter = `---
title: >
    ${title}
date: ${date}
permalink: blog/${post.slug}/
layout: post.njk
categories: ${getAndFormatTaxonomy('categories', categories)}
tags: ${getAndFormatTaxonomy('tags', tags)}
---
`;

    // body html with post content
    const bodyHtml = `
<div class="post__title">${title}</div>

<div class="post__featured-image">
    <img
        src="${featuredImage.source_url}"
        loading="lazy"
        alt=""
        width="${featuredImage.width}"
        height="${featuredImage.height}">
</div>

<div class="post__content">
    ${decode(contentParsed.toString())}
</div>

`;
    const formattedBodyHtml = prettier.format(bodyHtml, { parser: 'html' });

    // File body
    const fileContents = `${frontMatter}${formattedBodyHtml}`;
    const fileName = path.join(__dirname, '..', 'src', 'blog', `${date}-${post.slug}.njk`);
    fs.writeFile(fileName, fileContents, (err) => {
        if (err) {
            return console.log(err);
        }
        console.log(`Successfully saved "${fileName}"`);
    });
}

async function fetchAndParsePosts(parsedUrl, page, perPage) {
    try {
        const response = await axios.get(parsedUrl.href);

        // If we've passed the valid number of pages, abort
        if (response.code === 'rest_post_invalid_page_number') {
            throw new Error('No more pages found-- exiting!');
        }

        const posts = await response.data;
        posts.forEach(formatAndSavePost);

        if (WPLOOP) {
            console.log('!!! Fetch the rest of the pages');
        }
    } catch (err) {
        logErrorAndExit(err);
    }
}

fetchAndParsePosts(WPURL_PARSED, PAGE, PER_PAGE);
