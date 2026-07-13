#!/usr/bin/env node
import { build } from 'esbuild';

await build({
    entryPoints: ['web/src/app.mjs'],
    bundle: true,
    outfile: 'web/dist/app.bundle.js',
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    sourcemap: true,
});

// Copy index.html to dist
import { copyFileSync } from 'fs';
copyFileSync('web/index.html', 'web/dist/index.html');

console.log('Build complete → web/dist/');
