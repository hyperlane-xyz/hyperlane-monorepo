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
import { supportedChainNames as testnet3Chains } from './environments/testnet3/chains';
import { rcMultisigIsmConfigs } from './rcMultisigIsmConfigs';

const chains = {
  mainnet2: mainnet2Chains,
  testnet3: testnet3Chains,
  test: testChains,
};

export const multisigIsm = (
  env: DeployEnvironment,
  chain: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): MultisigIsmConfig => {
  return context === Contexts.ReleaseCandidate
    ? { ...rcMultisigIsmConfigs[chain], type }
    : { ...defaultMultisigIsmConfigs[chain], type };
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
