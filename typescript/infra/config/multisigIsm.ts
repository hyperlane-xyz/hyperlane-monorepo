import {
  ChainMap,
  ChainName,
  MultisigIsmConfig,
  buildMultisigIsmConfigs,
  defaultMultisigConfigs,
  multisigConfigToIsmConfig,
} from '@hyperlane-xyz/sdk';

import { DeployEnvironment } from '../src/config/environment.js';

import { Contexts } from './contexts.js';
import { rcMultisigIsmConfigs } from './rcMultisigIsmConfigs.js';
import { getEnvChains } from './registry.js';

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
  return buildMultisigIsmConfigs(
    type,
    local,
    getEnvChains(env),
    multisigConfigs,
  );
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

  return multisigConfigToIsmConfig(type, configs[remote]);
};
