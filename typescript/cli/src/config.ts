import { ethers } from 'ethers';

import { Mailbox__factory, OverheadIgp__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  CoreConfig,
  GasOracleContractType,
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneContractsMap,
  HyperlaneDeploymentArtifacts,
  ModuleType,
  MultiProvider,
  MultisigIsmConfig,
  OverheadIgpConfig,
  RouterConfig,
  RoutingIsmConfig,
  buildAgentConfigDeprecated,
  chainMetadata,
  defaultMultisigIsmConfigs,
  filterAddressesMap,
  multisigIsmVerificationCost,
  objFilter,
  objMerge,
} from '@hyperlane-xyz/sdk';
import { hyperlaneEnvironments } from '@hyperlane-xyz/sdk/dist/consts/environments';
import { types, utils } from '@hyperlane-xyz/utils';

import { chains } from '../examples/chains.js';
import { multisigIsmConfig } from '../examples/multisig_ism.js';

import { TestRecipientConfig } from './core/TestRecipientDeployer.js';
import { tryReadJSON } from './json.js';

let multiProvider: MultiProvider;

export function getMultiProvider() {
  if (!multiProvider) {
    const chainConfigs = { ...chainMetadata, ...chains };
    multiProvider = new MultiProvider(chainConfigs);
  }
  return multiProvider;
}
export function assertBytesN(value: string, length: number): string {
  const valueWithPrefix = utils.ensure0x(value);
  if (
    ethers.utils.isHexString(valueWithPrefix) &&
    ethers.utils.hexDataLength(valueWithPrefix) == length
  ) {
    return valueWithPrefix;
  }
  throw new Error(
    `Invalid value ${value}, must be a ${length} byte hex string`,
  );
}

export function assertBytes32(value: string): string {
  return assertBytesN(value, 32);
}

export function assertBytes20(value: string): string {
  return assertBytesN(value, 20);
}

export function assertUnique(
  values: (argv: any) => string[],
): (argv: any) => void {
  return (argv: any) => {
    const _values = values(argv);
    const hasDuplicates = new Set(_values).size !== _values.length;
    if (hasDuplicates) {
      throw new Error(`Must provide unique values, got ${_values}`);
    }
  };
}

export function assertBalances(
  multiProvider: MultiProvider,
  chainsFunc: (argv: any) => ChainName[],
): (argv: any) => Promise<void> {
  return async (argv: any) => {
    const chains = chainsFunc(argv);
    const signer = new ethers.Wallet(argv.key);
    const address = await signer.getAddress();
    await Promise.all(
      chains.map(async (chain: ChainName) => {
        const balance = await multiProvider
          .getProvider(chain)
          .getBalance(address);
        if (balance.isZero())
          throw new Error(`${address} has no balance on ${chain}`);
      }),
    );
  };
}

export function coerceAddressToBytes32(value: string): string {
  if (ethers.utils.isHexString(value)) {
    const length = ethers.utils.hexDataLength(value);
    if (length == 32) {
      return value;
    } else if (length == 20) {
      return utils.addressToBytes32(value);
    }
  }
  throw new Error(`Invalid value ${value}, must be a 20 or 32 byte hex string`);
}

export function buildIsmConfig(
  owner: types.Address,
  remotes: ChainName[],
): RoutingIsmConfig {
  const mergedMultisigIsmConfig: ChainMap<MultisigIsmConfig> = objMerge(
    defaultMultisigIsmConfigs,
    multisigIsmConfig,
  );
  return {
    owner,
    type: ModuleType.ROUTING,
    domains: Object.fromEntries(
      remotes.map((remote) => [remote, mergedMultisigIsmConfig[remote]]),
    ),
  };
}

export function buildIsmConfigMap(
  owner: types.Address,
  chains: ChainName[],
  remotes: ChainName[],
): ChainMap<RoutingIsmConfig> {
  return Object.fromEntries(
    chains.map((chain) => {
      const ismConfig = buildIsmConfig(
        owner,
        remotes.filter((r) => r !== chain),
      );
      return [chain, ismConfig];
    }),
  );
}

export function buildCoreConfigMap(
  owner: types.Address,
  local: ChainName,
  remotes: ChainName[],
): ChainMap<CoreConfig> {
  const configMap: ChainMap<CoreConfig> = {};
  configMap[local] = {
    owner,
    defaultIsm: buildIsmConfig(owner, remotes),
  };
  return configMap;
}

export function buildRouterConfigMap(
  owner: types.Address,
  chains: ChainName[],
  addressesMap: HyperlaneAddressesMap<any>,
): ChainMap<RouterConfig> {
  const routerConfigFactories = {
    mailbox: new Mailbox__factory(),
    defaultIsmInterchainGasPaymaster: new OverheadIgp__factory(),
  };
  const filteredAddressesMap = filterAddressesMap(
    addressesMap,
    routerConfigFactories,
  );
  return Object.fromEntries(
    chains.map((chain) => {
      const routerConfig: RouterConfig = {
        owner,
        mailbox: filteredAddressesMap[chain].mailbox,
        interchainGasPaymaster:
          filteredAddressesMap[chain].defaultIsmInterchainGasPaymaster,
      };
      return [chain, routerConfig];
    }),
  );
}

export function buildTestRecipientConfigMap(
  chains: ChainName[],
  addressesMap: HyperlaneAddressesMap<any>,
): ChainMap<TestRecipientConfig> {
  return Object.fromEntries(
    chains.map((chain) => {
      const interchainSecurityModule =
        addressesMap[chain].interchainSecurityModule ??
        ethers.constants.AddressZero;
      return [chain, { interchainSecurityModule }];
    }),
  );
}

export function buildIgpConfigMap(
  owner: types.Address,
  deployChains: ChainName[],
  allChains: ChainName[],
): ChainMap<OverheadIgpConfig> {
  const mergedMultisigIsmConfig: ChainMap<MultisigIsmConfig> = objMerge(
    defaultMultisigIsmConfigs,
    multisigIsmConfig,
  );
  const configMap: ChainMap<OverheadIgpConfig> = {};
  for (const local of deployChains) {
    const overhead: ChainMap<number> = {};
    const gasOracleType: ChainMap<GasOracleContractType> = {};
    for (const remote of allChains) {
      if (local === remote) continue;
      overhead[remote] = multisigIsmVerificationCost(
        mergedMultisigIsmConfig[remote].threshold,
        mergedMultisigIsmConfig[remote].validators.length,
      );
      gasOracleType[remote] = GasOracleContractType.StorageGasOracle;
    }
    configMap[local] = {
      owner,
      beneficiary: owner,
      gasOracleType,
      overhead,
      oracleKey: 'TODO',
    };
  }
  return configMap;
}

export const sdkContractAddressesMap = {
  ...hyperlaneEnvironments.testnet,
  ...hyperlaneEnvironments.mainnet,
};

export function artifactsAddressesMap(): HyperlaneContractsMap<any> {
  return (
    tryReadJSON<HyperlaneContractsMap<any>>('./artifacts', 'addresses.json') ||
    {}
  );
}

export function buildOverriddenAgentConfig(
  chains: ChainName[],
  multiProvider: MultiProvider,
  startBlocks: ChainMap<number>,
) {
  const mergedAddressesMap: HyperlaneAddressesMap<any> = objMerge(
    sdkContractAddressesMap,
    artifactsAddressesMap(),
  );
  const filteredAddressesMap = objFilter(
    mergedAddressesMap,
    (chain, v): v is HyperlaneAddresses<any> =>
      chains.includes(chain) &&
      !!v.mailbox &&
      !!v.interchainGasPaymaster &&
      !!v.validatorAnnounce,
  ) as unknown as ChainMap<HyperlaneDeploymentArtifacts>;

  return buildAgentConfigDeprecated(
    chains,
    multiProvider,
    filteredAddressesMap,
    startBlocks,
  );
}
