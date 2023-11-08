import { objMerge } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types';
import { CoreChainName } from '../chains';

import mainnet from './mainnet.json';
import testnet from './testnet.json';

export const hyperlaneEnvironments = { testnet, mainnet };

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
