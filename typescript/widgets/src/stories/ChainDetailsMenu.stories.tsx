import { Meta, StoryObj } from '@storybook/react';

import { chainMetadata } from '@hyperlane-xyz/registry';

import { ChainDetailsMenu } from '../chains/ChainDetailsMenu.js';

const meta = {
  title: 'ChainDetailsMenu',
  component: ChainDetailsMenu,
} satisfies Meta<typeof ChainDetailsMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultChainDetails = {
  args: {
    chainMetadata: chainMetadata['ethereum'],
    onClickBack: undefined,
  },
} satisfies Story;
