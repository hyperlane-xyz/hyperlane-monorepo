import React from 'react';
import { ComponentStory, ComponentMeta } from '@storybook/react';

import { WarpRouteVisualiser } from '../components/WarpRouteVisualiser';
import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

export default {
  title: 'Components/WarpRouteVisualiser',
  component: WarpRouteVisualiser,
} as ComponentMeta<typeof WarpRouteVisualiser>;

const Template: ComponentStory<typeof WarpRouteVisualiser> = (args) => <WarpRouteVisualiser {...args} />;

const sampleConfig: WarpRouteDeployConfig = {
  ethereum: {
    type: 'collateral',
    name: 'Ether Token',
    symbol: 'ETH',
    decimals: 18,
    token: '0x1234567890abcdef1234567890abcdef12345678',
    owner: '0xowner1_ethereum_address_long_enough_to_wrap',
    mailbox: '0xmailbox1_ethereum_address_long_enough_to_wrap',
    interchainSecurityModule: { type: 'aggregate', modules: [{type: 'merkleRoot'}, {type: 'messageId'}, {type: 'axelar'}] },
    hook: { type: 'merkleTreeHook' },
  },
  polygon: {
    type: 'xERC20',
    name: 'Polygon Side Token',
    symbol: 'MATIC',
    decimals: 18,
    token: '0xabcdef1234567890abcdef1234567890abcdef12',
    owner: '0xowner2_polygon_address_very_long_for_testing_wrapping',
    mailbox: '0xmailbox2_polygon_address_very_long_for_testing_wrapping',
    interchainSecurityModule: '0xismAddressPolygon_another_long_address_to_see_wrapping',
  },
  avalanche: {
    type: 'synthetic',
    name: 'Avalanche Warp Token',
    symbol: 'AVAX',
    decimals: 18,
    owner: '0xowner3_avalanche_address',
    mailbox: '0xmailbox3_avalanche_address',
    hook: '0xhookAddressAvalanche_another_long_address_for_hook',
    interchainSecurityModule: { type: 'routing', owner: "0xAnotherOwner", domains: {"polygon": "0xPolygonIsm"} }
  },
  optimism: {
    type: 'collateralVault',
    name: 'Optimism Vault Token',
    symbol: 'OPV',
    decimals: 18,
    token: '0xTokenAddressForOptimismVault',
    owner: '0xOwnerForOptimismVault',
    mailbox: '0xMailboxForOptimismVault',
  }
};

export const Default = Template.bind({});
Default.args = {
  config: sampleConfig,
};

const partialConfig: WarpRouteDeployConfig = {
  bsc: {
    type: 'synthetic',
    name: 'Binance Smart Chain Token',
    // symbol is missing
    decimals: 8,
    owner: '0xowner4_bsc_address',
    mailbox: '0xmailbox4_bsc_address',
    // hook is missing
    // interchainSecurityModule is missing
  },
  arbitrum: {
    type: 'collateralFiat',
    name: 'Arbitrum Fiat Token',
    symbol: 'ARBF',
    decimals: 6,
    token: '0xTokenAddressForArbitrumFiat',
    owner: '0xOwnerForArbitrumFiat',
    mailbox: '0xMailboxForArbitrumFiat',
    hook: {type: "domainRoutingHook", owner: "0xOwner", domainHooks: {"ethereum": "0xEthereumHook"}}
  }
};

export const WithMissingFields = Template.bind({});
WithMissingFields.args = {
  config: partialConfig,
};

const emptyConfig: WarpRouteDeployConfig = {};
export const EmptyConfig = Template.bind({});
EmptyConfig.args = {
  config: emptyConfig,
};
