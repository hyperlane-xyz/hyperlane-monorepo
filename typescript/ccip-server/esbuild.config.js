const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: ['src/server.ts'],
    outfile: 'dist/server.js',
    bundle: true,
    minify: false,
    treeShaking: true,
    platform: 'node',
  })
  .catch(() => process.exit(1));
