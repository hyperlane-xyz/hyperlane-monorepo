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
    overrideChainMetadata: undefined,
    onChangeOverrideMetadata: () => {},
    onClickBack: undefined,
    onRemoveChain: undefined,
  },
} satisfies Story;

export const PartialOverrideChainDetails = {
  args: {
    chainMetadata: chainMetadata['ethereum'],
    overrideChainMetadata: { rpcUrls: [{ http: 'https://rpc.fakeasdf.com' }] },
    onChangeOverrideMetadata: () => {},
    onClickBack: undefined,
    onRemoveChain: undefined,
  },
} satisfies Story;

export const FullOverrideChainDetails = {
  args: {
    chainMetadata: chainMetadata['arbitrum'],
    overrideChainMetadata: chainMetadata['arbitrum'],
    onChangeOverrideMetadata: () => {},
    onClickBack: () => {},
    onRemoveChain: () => {},
  },
} satisfies Story;
