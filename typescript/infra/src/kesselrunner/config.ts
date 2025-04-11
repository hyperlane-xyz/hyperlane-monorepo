import { IRegistry } from '@hyperlane-xyz/registry';
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
import { DeployEnvironment } from '../config/environment.js';
import { Role } from '../roles.js';

// testnet4 neutron relayer
export const relayerAddress = '0xf2c72c0befa494d62949a1699a99e2c605a0b636';

// rc-testnet4-key-kesselrunner-validator-0
export const ltOwner = '0xB282Db526832b160144Fc712fccEBC8ceFd9d19a';
export const ownerConfig = {
  owner: ltOwner,
};

export const environment = 'testnet4';
export const targetNetworks = [
  'basesepolia',
  'arbitrumsepolia',
  'sepolia',
  'bsctestnet',
  'optimismsepolia',
];

export const kesselRunConfig = {
  hourlyRate: 600, // Example hourly rate
  bursts: 10,
  transactionsPerMinute: Math.floor(600 / 60),
  burstInterval: 60000, // 1 minute in milliseconds
  distArbOp: {},
  distBaseBscEth: {},
};

export type KesselRunner = {
  environment: DeployEnvironment;
  targetNetworks: ChainName[];
  multiProvider: MultiProvider;
  registry: IRegistry;
};

export async function setKesselRunnerKey(
  multiProvider: MultiProvider,
): Promise<void> {
  const key = new AgentGCPKey(
    environment,
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
  const key = new AgentGCPKey(environment, Contexts.Hyperlane, Role.Deployer);
  await key.createIfNotExists();
  const signer = await key.getSigner();
  multiProvider.setSharedSigner(signer);
}

export async function getKesselRunMultiProvider(): Promise<KesselRunner> {
  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry();
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
  );

  await setKesselRunnerKey(multiProvider);

  return {
    environment,
    targetNetworks,
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
      ...ownerConfig,
    };

    const pausableIsm: PausableIsmConfig = {
      type: IsmType.PAUSABLE,
      paused: false,
      ...ownerConfig,
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
