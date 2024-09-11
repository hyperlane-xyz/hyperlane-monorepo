import { Meta, StoryObj } from '@storybook/react';

import { chainMetadata } from '@hyperlane-xyz/registry';

import { ChainSearchMenu } from '../chains/ChainSearchMenu.js';

const meta = {
  title: 'ChainSearchMenu',
  component: ChainSearchMenu,
} satisfies Meta<typeof ChainSearchMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Example = {
  args: {
    chainMetadata,
  },
} satisfies Story;
