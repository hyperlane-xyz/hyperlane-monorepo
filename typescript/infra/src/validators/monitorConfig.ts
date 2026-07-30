import { ChainMap, defaultMultisigConfigs } from '@hyperlane-xyz/sdk';
import { Address, objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { ezEthValidators } from '../../config/environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConfig.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { CheckpointSyncerType } from '../config/agent/validator.js';
import { DeployEnvironment } from '../config/deploy-environment.js';

// Named, whitelisted validator sets that the checkpoint liveness monitor tracks.
// Each set is checked independently so a validator's lag can be compared against
// its own peer group (the "relative diff") in addition to the on-chain merkle
// count (the "absolute" ground truth).
export enum ValidatorSetName {
  DefaultIsm = 'default-ism',
  Renzo = 'renzo',
  FastPath = 'fastpath',
}

export interface MonitoredValidator {
  address: Address;
  alias: string;
}

export interface MonitoredValidatorSet {
  name: ValidatorSetName;
  validators: ChainMap<MonitoredValidator[]>;
}

// External fastpath validators that sign to their own S3 buckets. They announce
// their storage locations on-chain (see announce-fastpath-validators.ts), so the
// monitor resolves their location via ValidatorAnnounce like every other set.
const EXTERNAL_FASTPATH_VALIDATORS: MonitoredValidator[] = [
  { address: '0x93911a19cd8914220f6287d515187e7751817683', alias: 'Enigma' },
  { address: '0xf9c6519dbd9a42bc6a60ea8daec3fa3830f40241', alias: 'Luganodes' },
];

function getDefaultIsmValidatorSet(): ChainMap<MonitoredValidator[]> {
  return objMap(defaultMultisigConfigs, (_chain, config) =>
    config.validators.map((v) => ({ address: v.address, alias: v.alias })),
  );
}

function getRenzoValidatorSet(): ChainMap<MonitoredValidator[]> {
  return objMap(ezEthValidators, (_chain, config) =>
    config.validators.map((v) => ({ address: v.address, alias: v.alias })),
  );
}

function getFastPathValidatorSet(
  environment: DeployEnvironment,
): ChainMap<MonitoredValidator[]> {
  const agentConfig = getAgentConfig(Contexts.FastPath, environment);
  const fastpathChains = agentConfig.contextChainNames.validator;
  const result: ChainMap<MonitoredValidator[]> = {};

  // In-house (AW) fastpath validators, read from the fastpath agent config.
  if (agentConfig.validators) {
    for (const [chain, chainConfig] of Object.entries(
      agentConfig.validators.chains,
    )) {
      if (!fastpathChains.includes(chain)) continue;
      for (const v of chainConfig.validators) {
        if (v.checkpointSyncer.type !== CheckpointSyncerType.S3) continue;
        (result[chain] ??= []).push({ address: v.address, alias: v.name });
      }
    }
  }

  // External fastpath validators run across the same fastpath chains.
  for (const chain of fastpathChains) {
    for (const external of EXTERNAL_FASTPATH_VALIDATORS) {
      (result[chain] ??= []).push(external);
    }
  }

  return result;
}

export function getMonitoredValidatorSets(
  environment: DeployEnvironment,
): MonitoredValidatorSet[] {
  return [
    {
      name: ValidatorSetName.DefaultIsm,
      validators: getDefaultIsmValidatorSet(),
    },
    { name: ValidatorSetName.Renzo, validators: getRenzoValidatorSet() },
    {
      name: ValidatorSetName.FastPath,
      validators: getFastPathValidatorSet(environment),
    },
  ];
}
