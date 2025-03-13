import * as path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// These packages should be included in the bundle otherwise they will be installed
// when installing the cli with npm i -g which will fail if new changes are not in
// in the NPM registry
const bundleWhitelist = new Set([
  '@hyperlane-xyz/registry',
  '@hyperlane-xyz/sdk',
  '@hyperlane-xyz/utils',
  '@hyperlane-xyz/core',
]);

export default {
  entry: './dist/cli.js',
  target: 'node',
  mode: 'production',
  optimization: {
    minimize: false,
  },
  output: {
    filename: 'cli.js',
    path: path.resolve(__dirname, 'cli-bundle'),
    library: { type: 'module' },
  },
  experiments: {
    outputModule: true,
  },
  resolve: {
    extensions: ['.js', '.json'],
    conditionNames: ['node', 'import'],
    modules: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(__dirname, '../node_modules'),
      'node_modules',
    ],
  },
  externals: [
    ({ request }, callback) => {
      // Bundle relative paths and whitelisted modules.
      if (!request || request.startsWith('.') || bundleWhitelist.has(request)) {
        return callback();
      }

      // Install as an external ES module by default.
      callback(null, `module ${request}`);
    },
  ],
  plugins: [
    new webpack.BannerPlugin({
      banner: `#!/usr/bin/env node`,
      raw: true,
      entryOnly: true,
    }),
  ],
};
