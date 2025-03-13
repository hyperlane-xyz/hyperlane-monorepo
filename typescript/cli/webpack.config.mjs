// webpack.config.js
import * as path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  entry: './dist/cli.js',
  target: 'node',
  mode: 'production',
  output: {
    filename: 'cli.js',
    path: path.resolve(__dirname, 'cli-bundle'),
  },
  resolve: {
    extensions: ['.js', '.json'],
    modules: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(__dirname, '../node_modules'),
      'node_modules',
    ],
  },
  experiments: {
    outputModule: true,
  },
  plugins: [
    new webpack.BannerPlugin({
      banner: '#!/usr/bin/env node',
      raw: true,
      entryOnly: true,
    }),
  ],
};
