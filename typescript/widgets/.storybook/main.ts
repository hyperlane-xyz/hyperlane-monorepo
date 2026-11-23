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
  // react-docgen-typescript (Storybook 7's default) runs out of heap on the
  // widget stories; react-docgen is also Storybook 8's default.
  typescript: {
    reactDocgen: 'react-docgen',
  },
  refs: {
    '@chakra-ui/react': {
      disable: true,
    },
  },
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(config, { configType: _configType }) {
    return mergeConfig(config, {
      define: { 'process.env': {} },
      build: {
        // ChainLogo.stories.tsx uses top-level await.
        target: 'esnext',
        // utils loads this Node-only package only when running in Kubernetes,
        // never in the browser, so keep it out of the bundle.
        rollupOptions: { external: ['@google-cloud/pino-logging-gcp-config'] },
      },
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
