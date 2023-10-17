import {
  ChainMap,
  ChainName,
  MultisigIsmConfig,
  defaultMultisigIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { objFilter, objMap } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../src/config';

import { Contexts } from './contexts';
import { supportedChainNames as mainnet2Chains } from './environments/mainnet2/chains';
import { chainNames as testChains } from './environments/test/chains';
import { supportedChainNames as testnet4Chains } from './environments/testnet4/chains';
import { rcMultisigIsmConfigs } from './rcMultisigIsmConfigs';

const chains = {
  mainnet2: mainnet2Chains,
  testnet4: testnet4Chains,
  test: testChains,
};

export const multisigIsms = (
  env: DeployEnvironment,
  local: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): ChainMap<MultisigIsmConfig> =>
  objMap(
    objFilter(
      context === Contexts.ReleaseCandidate
        ? rcMultisigIsmConfigs
        : defaultMultisigIsmConfigs,
      (chain, config): config is MultisigIsmConfig =>
        chain !== local && chains[env].includes(chain),
    ),
    (_, config) => ({
      ...config,
      type,
    }),
  );

export const multisigIsm = (
  remote: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): MultisigIsmConfig => {
  const configs =
    context === Contexts.ReleaseCandidate
      ? rcMultisigIsmConfigs
      : defaultMultisigIsmConfigs;

  return {
    ...configs[remote],
    type,
  };
};
