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

function formatAndSavePost(post) {
    // Split data on T to only get YYYY-MM-DD
    const date = post.date.split('T')[0];
    console.log(date);

    // Get the post title
    const title = get(post, 'title.rendered');

    // Get the post content
    const content = get(post, 'content.rendered')
        .replace('<!--more-->', '');

    // When using &_embed, linked data is stored in the _embedded object
    const embedded = get(post, '_embedded');

    // Featured image
    const featuredImage = get(embedded, 'wp:featuredmedia.0.media_details.sizes.full');
    console.log(featuredImage);

    if (WPSAVEIMAGES) {
        console.log('!!! Save image');
    }

    // Post images
    // TODO

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

    // Frontmatter meta information
    const frontMatter = `---
title: >
    ${title}
date: ${date}
permalink: ${post.slug}/
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
    ${decode(content)}
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

    // https.get(url, (response) => {
    //     let data = '';

    //     // called when a data chunk is received.
    //     response.on('data', (chunk) => {
    //         data += chunk;
    //     });

    //     // called when the complete response is received.
    //     response.on('end', () => {
    //         const items = JSON.parse(data);
    //         items.forEach((post) => {
    //             const date = post.date.split('T')[0]; // Split data on T to only get YYYY-MM-DD
    //             transformAndWriteToFile({
    //                 frontmatterMarkdown: {
    //                     frontmatter: [
    //                         { title: post.title.rendered },
    //                         { date },
    //                         // Must have trailing slash to if you want pretty URLs
    //                         { permalink: `${post.slug}/` },
    //                         { layout: 'layout/post' },
    //                     ],
    //                     body: post.content.rendered,
    //                 },
    //                 path: './src/blog', // Location to place the files
    //                 fileName: `${date}-${post.slug}.md`,
    //             });
    //         });
    //     });
    // }).on('error', (error) => {
    //     // eslint-disable-next-line no-console
    //     console.log(`Error: ${error.message}`);
    // });
}

fetchAndParsePosts(WPURL_PARSED, PAGE, PER_PAGE);
