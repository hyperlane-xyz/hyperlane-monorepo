import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  Chains,
  IsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { Address, objFilter, objMap } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../src/config';

import { Contexts } from './contexts';
import { supportedChainNames as mainnet2Chains } from './environments/mainnet2/chains';
import { owners as mainnet2Owners } from './environments/mainnet2/owners';
import { chainNames as testChains } from './environments/test/chains';
import { owners as testOwners } from './environments/test/owners';
import { supportedChainNames as testnet3Chains } from './environments/testnet3/chains';
import { owners as testnet3Owners } from './environments/testnet3/owners';
import { rcMultisigIsmConfigs } from './multisigIsm';

const chains = {
  mainnet2: mainnet2Chains,
  testnet3: testnet3Chains,
  test: testChains,
};

const owners = {
  testnet3: testnet3Owners,
  mainnet2: mainnet2Owners,
  test: testOwners,
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

/// Routing => Multisig ISM type
export const routingIsm = (
  environment: DeployEnvironment,
  local: ChainName,
  type: MultisigIsmConfig['type'],
  context: Contexts,
): RoutingIsmConfig => {
  const defaultMultisigIsmConfigs = multisigIsms(
    environment,
    local,
    type,
    context,
  );
  return {
    type: ModuleType.ROUTING,
    domains: defaultMultisigIsmConfigs,
    owner: owners[environment][local],
  };
};

// mainnet cache
const aggregationIsmAddresses: Record<string, string> = {
  [Chains.arbitrum]: '0x7995D00bdDb146334d6568b627bcd2a7DdA3B005',
  [Chains.avalanche]: '0xF6bF41939ebA2363A6e311E886Ed4a5ab3dc1F5D',
  [Chains.bsc]: '0x294F19d5fe29646f8E2cA4A71b6B18b78db10F9f',
  [Chains.celo]: '0x656bF500F0E2EE55F26dF3bc69b44c6eA84dd065',
  [Chains.ethereum]: '0xe39eA548F36d1c3DA9b871Badd11345f836a290A',
  [Chains.gnosis]: '0xD0Ec4de35069520CD17522281D36DD299525d85f',
  [Chains.moonbeam]: '0x04100049AC8e279C85E895d48aab1E188152e939',
  [Chains.optimism]: '0x99663d142576204284b91e96d39771db94eD5188',
  [Chains.polygon]: '0x0673cc1cc5eb80816E0d0E2dA5FE10053Da97943',
};

/// 1/2 Aggregation => Routing => Multisig ISM
export const aggregationIsm = (
  environment: DeployEnvironment,
  local: ChainName,
  context: Contexts,
): AggregationIsmConfig | Address => {
  if (environment === 'mainnet2') {
    return aggregationIsmAddresses[local];
  }

  const config: AggregationIsmConfig = {
    type: ModuleType.AGGREGATION,
    modules: [
      // ORDERING MATTERS
      routingIsm(environment, local, ModuleType.MERKLE_ROOT_MULTISIG, context),
      routingIsm(environment, local, ModuleType.MESSAGE_ID_MULTISIG, context),
    ],
    threshold: 1,
  };
  return config;
};

const replacerEnum = (key: string, value: any) => {
  if (key === 'type') {
    switch (value) {
      case ModuleType.AGGREGATION:
        return 'AGGREGATION';
      case ModuleType.ROUTING:
        return 'ROUTING';
      case ModuleType.MERKLE_ROOT_MULTISIG:
        return 'MERKLE_ROOT_MULTISIG';
      case ModuleType.LEGACY_MULTISIG:
        return 'LEGACY_MULTISIG';
      case ModuleType.MESSAGE_ID_MULTISIG:
        return 'MESSAGE_ID_MULTISIG';
      default:
        return value;
    }
  }
  return value;
};

export const printIsmConfig = (ism: IsmConfig): string => {
  return JSON.stringify(ism, replacerEnum, 2);
};
