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
import { Address, objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { supportedChainNames } from '../../config/environments/testnet4/supportedChainNames.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { AgentGCPKey } from '../agents/gcp.js';
import { DeployEnvironment } from '../config/environment.js';
import { Role } from '../roles.js';

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL3_ABI = `[{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"aggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes[]","name":"returnData","type":"bytes[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bool","name":"allowFailure","type":"bool"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call3[]","name":"calls","type":"tuple[]"}],"name":"aggregate3","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bool","name":"allowFailure","type":"bool"},{"internalType":"uint256","name":"value","type":"uint256"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call3Value[]","name":"calls","type":"tuple[]"}],"name":"aggregate3Value","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"blockAndAggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes32","name":"blockHash","type":"bytes32"},{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"getBasefee","outputs":[{"internalType":"uint256","name":"basefee","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"}],"name":"getBlockHash","outputs":[{"internalType":"bytes32","name":"blockHash","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getBlockNumber","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getChainId","outputs":[{"internalType":"uint256","name":"chainid","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockCoinbase","outputs":[{"internalType":"address","name":"coinbase","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockDifficulty","outputs":[{"internalType":"uint256","name":"difficulty","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockGasLimit","outputs":[{"internalType":"uint256","name":"gaslimit","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCurrentBlockTimestamp","outputs":[{"internalType":"uint256","name":"timestamp","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"addr","type":"address"}],"name":"getEthBalance","outputs":[{"internalType":"uint256","name":"balance","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getLastBlockHash","outputs":[{"internalType":"bytes32","name":"blockHash","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bool","name":"requireSuccess","type":"bool"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"tryAggregate","outputs":[{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"bool","name":"requireSuccess","type":"bool"},{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"bytes","name":"callData","type":"bytes"}],"internalType":"struct Multicall3.Call[]","name":"calls","type":"tuple[]"}],"name":"tryBlockAndAggregate","outputs":[{"internalType":"uint256","name":"blockNumber","type":"uint256"},{"internalType":"bytes32","name":"blockHash","type":"bytes32"},{"components":[{"internalType":"bool","name":"success","type":"bool"},{"internalType":"bytes","name":"returnData","type":"bytes"}],"internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],"stateMutability":"payable","type":"function"}]`;

export const funderConfig: Record<string, Address> = {
  owner: '0xB282Db526832b160144Fc712fccEBC8ceFd9d19a',
  relayer: '0xf2c72c0befa494d62949a1699a99e2c605a0b636',
  vanguard0: '0x2c9209efcaff2778d945e18fb24174e16845dc62',
  vanguard1: '0x939043d9db00f6ada1b742239beb7ddd5bf82096',
  vanguard2: '0x45b58e4d46a89c003cc7126bd971eb3794a66aeb',
  vanguard3: '0x1f4fdb150e8c9fda70687a2fd481e305af1e7f8e',
  vanguard4: '0xe41b227e7aaaf7bbd1d60258de0dd76a11a0c3fc',
};

// rc-testnet4-key-kesselrunner-validator-0
export const ownerConfig = {
  owner: funderConfig.owner,
};

export const environment = 'testnet4';
export const targetNetworks = [
  'basesepolia',
  'arbitrumsepolia',
  'sepolia',
  'bsctestnet',
  'optimismsepolia',
];

export const HOURLY_RATE = 2500000;

export const kesselRunConfig: {
  bursts: number;
  burstInterval: number;
  distArbOp: ChainMap<number>;
  distBaseBscEth: ChainMap<number>;
  distro: ChainMap<number>;
  multicallBatchSize: number;
} = {
  bursts: 12,
  burstInterval: 5, // seconds
  distArbOp: {
    arbitrumsepolia: 0.02,
    basesepolia: 0.23,
    bsctestnet: 0.23,
    optimismsepolia: 0.02,
    sepolia: 0.5,
  },
  distBaseBscEth: {
    arbitrumsepolia: 0.02,
    basesepolia: 0.02,
    bsctestnet: 0.02,
    optimismsepolia: 0.02,
    sepolia: 0.02,
  },
  distro: {
    arbitrumsepolia: 0.34,
    basesepolia: 0.38,
    bsctestnet: 0.08,
    optimismsepolia: 0.06,
    sepolia: 0.14,
  },
  multicallBatchSize: 100,
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
