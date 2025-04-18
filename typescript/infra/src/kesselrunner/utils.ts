import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  IsmType,
  MultiProvider,
  MultisigConfig,
  MultisigIsmConfig,
  PausableIsmConfig,
  RoutingIsmConfig,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { supportedChainNames } from '../../config/environments/testnet4/supportedChainNames.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { AgentGCPKey } from '../agents/gcp.js';
import { Role } from '../roles.js';

import {
  KESSEL_RUN_ENV,
  KESSEL_RUN_OWNER_CONFIG,
  KESSEL_RUN_TARGET_NETWORKS,
} from './config.js';
import { KesselRunner } from './types.js';

export async function setKesselRunnerKey(
  multiProvider: MultiProvider,
): Promise<void> {
  const key = new AgentGCPKey(
    KESSEL_RUN_ENV,
    Contexts.ReleaseCandidate,
    Role.Validator,
    'kesselrunner',
    0,
  );
  await key.createIfNotExists();
  const signer = await key.getSigner();
  multiProvider.setSharedSigner(signer);
}

export async function setDeployerKey(
  multiProvider: MultiProvider,
): Promise<void> {
  const key = new AgentGCPKey(
    KESSEL_RUN_ENV,
    Contexts.Hyperlane,
    Role.Deployer,
  );
  await key.createIfNotExists();
  const signer = await key.getSigner();
  multiProvider.setSharedSigner(signer);
}

export async function getKesselRunMultiProvider(): Promise<KesselRunner> {
  const envConfig = getEnvironmentConfig(KESSEL_RUN_ENV);
  const registry = await envConfig.getRegistry();
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
  );

  await setKesselRunnerKey(multiProvider);

  return {
    environment: KESSEL_RUN_ENV,
    targetNetworks: KESSEL_RUN_TARGET_NETWORKS,
    multiProvider,
    registry,
  };
}

function multisigConfigToIsmConfig(
  type: MultisigIsmConfig['type'],
  config: MultisigConfig,
): MultisigIsmConfig {
  return {
    type,
    threshold: 4,
    validators: Array(6).fill(config.validators[0].address),
  };
}

export function getIsmConfigMap(
  targetNetworks: ChainName[],
): ChainMap<AggregationIsmConfig> {
  return targetNetworks.reduce((configMap, chain) => {
    const originMultisigs: ChainMap<MultisigConfig> = Object.fromEntries(
      supportedChainNames
        .filter((origin) => origin !== chain)
        .map((origin) => [origin, defaultMultisigConfigs[origin]]),
    );

    const merkleRoot = (multisig: MultisigConfig): MultisigIsmConfig =>
      multisigConfigToIsmConfig(IsmType.MERKLE_ROOT_MULTISIG, multisig);
    const messageIdIsm = (multisig: MultisigConfig): MultisigIsmConfig =>
      multisigConfigToIsmConfig(IsmType.MESSAGE_ID_MULTISIG, multisig);

    const routingIsm: RoutingIsmConfig = {
      type: IsmType.ROUTING,
      domains: objMap(
        originMultisigs,
        (_, multisig): AggregationIsmConfig => ({
          type: IsmType.AGGREGATION,
          modules: [messageIdIsm(multisig), merkleRoot(multisig)],
          threshold: 1,
        }),
      ),
      ...KESSEL_RUN_OWNER_CONFIG,
    };

    const pausableIsm: PausableIsmConfig = {
      type: IsmType.PAUSABLE,
      paused: false,
      ...KESSEL_RUN_OWNER_CONFIG,
    };

    const defaultIsm: AggregationIsmConfig = {
      type: IsmType.AGGREGATION,
      modules: [routingIsm, pausableIsm],
      threshold: 2,
    };

    configMap[chain] = defaultIsm;
    return configMap;
  }, {} as ChainMap<AggregationIsmConfig>);
}
