import { Meta, StoryObj } from '@storybook/react';

import { chainMetadata } from '@hyperlane-xyz/registry';

import { ChainSearchMenu } from '../chains/ChainSearchMenu.js';

const meta = {
  title: 'ChainSearchMenu',
  component: ChainSearchMenu,
} satisfies Meta<typeof ChainSearchMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultChainSearch = {
  args: {
    chainMetadata,
    onClickChain: (chain) => console.log('Clicked', chain),
  },
} satisfies Story;

export const WithCustomField = {
  args: {
    chainMetadata,
    customListItemField: {
      header: 'Custom Field',
      data: {
        alfajores: 'Custom Data',
        arbitrum: 'Custom Data',
      },
    },
  },
} satisfies Story;
