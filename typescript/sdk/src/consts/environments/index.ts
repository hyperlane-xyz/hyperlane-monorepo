import { ChainName } from '../../types';
import { objMerge } from '../../utils/objects';

import mainnet from './mainnet.json';
import test from './test.json';
import testnet from './testnet.json';

export const hyperlaneEnvironments = { test, testnet, mainnet };

export type HyperlaneEnvironment = keyof typeof hyperlaneEnvironments;
export type HyperlaneEnvironmentChain<E extends HyperlaneEnvironment> = Extract<
  keyof typeof hyperlaneEnvironments[E],
  ChainName
>;

// Note, this assumes no chain name is repeated across environments
export const hyperlaneContractAddresses = objMerge(
  hyperlaneEnvironments.testnet,
  hyperlaneEnvironments.mainnet,
);
