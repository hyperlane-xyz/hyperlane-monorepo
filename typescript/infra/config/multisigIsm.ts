import {
  ChainMap,
  ChainName,
  MultisigIsmConfig,
  buildMultisigIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { DeployEnvironment } from '../src/config/environment.js';

import { Contexts } from './contexts.js';
import { supportedChainNames as mainnet3Chains } from './environments/mainnet3/chains.js';
import { chainNames as testChains } from './environments/test/chains.js';
import { supportedChainNames as testnet4Chains } from './environments/testnet4/chains.js';
import { rcMultisigIsmConfigs } from './rcMultisigIsmConfigs.js';

const chains = {
  mainnet3: mainnet3Chains,
  testnet4: testnet4Chains,
  test: testChains,
};

export const multisigIsms = (
  env: DeployEnvironment,
  local: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): ChainMap<MultisigIsmConfig> => {
  const multisigConfigs =
    context === Contexts.ReleaseCandidate
      ? rcMultisigIsmConfigs
      : defaultMultisigConfigs;
  return buildMultisigIsmConfigs(type, local, chains[env], multisigConfigs);
};

export const multisigIsm = (
  remote: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): MultisigIsmConfig => {
  const configs =
    context === Contexts.ReleaseCandidate
      ? rcMultisigIsmConfigs
      : defaultMultisigConfigs;

  return {
    ...configs[remote],
    type,
  };
};
