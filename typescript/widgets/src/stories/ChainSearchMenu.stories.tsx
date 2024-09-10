import { Meta, StoryObj } from '@storybook/react';

import { chainMetadata } from '@hyperlane-xyz/registry';
import { MultiProtocolProvider } from '@hyperlane-xyz/sdk';

import { ChainSearchMenu } from '../chains/ChainSearchMenu.js';

const meta = {
  title: 'ChainSearchMenu',
  component: ChainSearchMenu,
} satisfies Meta<typeof ChainSearchMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

const multiProvider = new MultiProtocolProvider(chainMetadata);

export const Example = {
  args: {
    multiProvider,
  },
} satisfies Story;
