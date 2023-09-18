import { objMerge } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types';
import { CoreChainName } from '../chains';

import mainnetSealevel from './mainnet-sealevel.json';
import mainnet from './mainnet.json';
import test from './test.json';
import testnetSealevel from './testnet-sealevel.json';
import testnet from './testnet.json';

export const hyperlaneEnvironments1 = { test, testnet, mainnet };
export const hyperlaneEnvironmentsWithSealevel = {
  ...hyperlaneEnvironments1,
  mainnet: { ...mainnet, ...mainnetSealevel },
  testnet: { ...testnet, ...testnetSealevel },
};
export const hyperlaneEnvironments = hyperlaneEnvironmentsWithSealevel;

export type HyperlaneEnvironment = keyof typeof hyperlaneEnvironments;
export type HyperlaneEnvironmentChain<E extends HyperlaneEnvironment> = Extract<
  keyof typeof hyperlaneEnvironments[E],
  ChainName
>;

// Note, this assumes no chain name is repeated across environments
export const hyperlaneContractAddresses = objMerge(
  hyperlaneEnvironments.testnet,
  hyperlaneEnvironments.mainnet,
) as Record<CoreChainName, typeof hyperlaneEnvironments['mainnet']['ethereum']>;
