import {
  ChainMap,
  ChainName,
  MultisigIsmConfig,
  buildMultisigIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { DeployEnvironment } from '../src/config';

import { Contexts } from './contexts';
import { supportedChainNames as mainnet3Chains } from './environments/mainnet3/chains';
import { chainNames as testChains } from './environments/test/chains';
import { supportedChainNames as testnet4Chains } from './environments/testnet4/chains';
import { rcMultisigIsmConfigs } from './rcMultisigIsmConfigs';

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
