import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    '@storybook/addon-links',
    '@storybook/addon-essentials',
    '@storybook/addon-onboarding',
    '@storybook/addon-interactions',
  ],
  refs: {
    '@chakra-ui/react': {
      disable: true,
    },
  },
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  docs: {
    autodocs: true,
  },
  async viteFinal(config, { configType }) {
    return mergeConfig(config, {
      define: { 'process.env': {} },
      optimizeDeps: {
        esbuildOptions: {
          plugins: [
            NodeGlobalsPolyfillPlugin({
              buffer: true,
            }),
          ],
        },
      },
    });
  },
};
export default config;
