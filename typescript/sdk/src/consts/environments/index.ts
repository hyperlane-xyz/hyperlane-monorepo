import { objMerge } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types.js';
import { CoreChainName } from '../chains.js';

import mainnet from './mainnet.json' assert { type: 'json' };
import testnet from './testnet.json' assert { type: 'json' };

export const hyperlaneEnvironments = { mainnet, testnet };

export type HyperlaneEnvironment = keyof typeof hyperlaneEnvironments;
export type HyperlaneEnvironmentChain<E extends HyperlaneEnvironment> = Extract<
  keyof (typeof hyperlaneEnvironments)[E],
  ChainName
>;

// Note, this assumes no chain name is repeated across environments
export const hyperlaneContractAddresses = objMerge(
  hyperlaneEnvironments.testnet,
  hyperlaneEnvironments.mainnet,
) as Record<
  CoreChainName,
  (typeof hyperlaneEnvironments)['mainnet']['ethereum']
>;
