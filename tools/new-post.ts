#!/usr/bin/env -S tsx

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = await yargs(hideBin(process.argv))
  .option('title', {
    type: 'string',
    description: 'Post title (required)',
    demandOption: true,
  })
  .option('slug', {
    type: 'string',
    description: 'URL slug (defaults to slugified title)',
  })
  .option('open', {
    type: 'boolean',
    default: true,
    description: 'Open the new file in $EDITOR',
  })
  .parse();

const title = argv.title.trim();
const slug = (argv.slug ?? slugify(title)).trim();

if (!slug) {
  console.error('❌ Could not derive a slug; pass --slug explicitly.');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const targetDir = path.join(process.cwd(), 'src', 'content', 'blog', slug);
const targetFile = path.join(targetDir, 'index.md');

if (await fileExists(targetFile)) {
  console.error(`❌ Post already exists: ${path.relative(process.cwd(), targetFile)}`);
  process.exit(1);
}

await fs.mkdir(targetDir, { recursive: true });

const content = `---
title: ${JSON.stringify(title)}
publishedDate: ${JSON.stringify(today)}
excerpt: ""
categories: []
tags: []
---

Write your post here.
`;

await fs.writeFile(targetFile, content, 'utf8');
console.log(`✅ Created ${path.relative(process.cwd(), targetFile)}`);

if (argv.open) {
  const editor = process.env.EDITOR;
  if (editor) {
    spawn(editor, [targetFile], { stdio: 'inherit', shell: true });
  } else {
    console.log('ℹ️  Set $EDITOR to auto-open new posts.');
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’"`]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
