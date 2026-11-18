import { Meta, StoryFn } from '@storybook/react';
import React from 'react';

import { GithubRegistry } from '@hyperlane-xyz/registry';

import { ChainLogo } from '../chains/ChainLogo.js';

const meta = {
  title: 'ChainLogo',
  component: ChainLogo,
} satisfies Meta<typeof ChainLogo>;
export default meta;

const Template: StoryFn<typeof ChainLogo> = (args) => <ChainLogo {...args} />;

const registry = new GithubRegistry();
await registry.getMetadata();

export const ChainNoBackground = Template.bind({});
ChainNoBackground.args = {
  chainName: 'ethereum',
  background: false,
  registry,
};

export const ChainWithBackground = Template.bind({});
ChainWithBackground.args = {
  chainName: 'ethereum',
  background: true,
  registry,
};

export const ChainWithBigSize = Template.bind({});
ChainWithBigSize.args = {
  chainName: 'ethereum',
  size: 100,
  registry,
};

export const ChainWithBackgroundAndBig = Template.bind({});
ChainWithBackgroundAndBig.args = {
  chainName: 'ethereum',
  size: 100,
  background: true,
  registry,
};

export const JustChainName = Template.bind({});
JustChainName.args = {
  chainName: 'ethereum',
  registry,
};

export const FakeChainName = Template.bind({});
FakeChainName.args = {
  chainName: 'myfakechain',
  registry,
};

export const SpecificLogoUri = Template.bind({});
SpecificLogoUri.args = {
  chainName: 'myfakechain',
  logoUri:
    'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/chains/arbitrum/logo.svg',
  registry,
};
