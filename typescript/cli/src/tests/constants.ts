import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { Wallet } from 'ethers';

import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { ChainMetadata, ProtocolMap } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, objMap } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../utils/files.js';

export const DEFAULT_E2E_TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while

export const E2E_TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${E2E_TEST_CONFIGS_PATH}/test-registry`;
export const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh
export const EXAMPLES_PATH = './examples';

export const WARP_DEPLOY_DEFAULT_FILE_NAME = `warp-route-deployment`;
export const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/${WARP_DEPLOY_DEFAULT_FILE_NAME}.yaml`;
export const WARP_READ_OUTPUT_PATH = `${TEMP_PATH}/${WARP_DEPLOY_DEFAULT_FILE_NAME}-read.yaml`;

export const TEST_CHAIN_NAMES_BY_PROTOCOL = {
  [ProtocolType.Ethereum]: {
    CHAIN_NAME_2: 'anvil2',
    CHAIN_NAME_3: 'anvil3',
    CHAIN_NAME_4: 'anvil4',
  },
  [ProtocolType.CosmosNative]: {
    CHAIN_NAME_1: 'hyp1',
    CHAIN_NAME_2: 'hyp2',
    CHAIN_NAME_3: 'hyp3',
  },
  [ProtocolType.Sealevel]: {
    UNSUPPORTED_CHAIN: 'sealevel1',
  },
} as const satisfies ProtocolMap<Record<string, string>>;

type TestProtocolType = keyof typeof TEST_CHAIN_NAMES_BY_PROTOCOL;
type TestChainName = {
  [K in TestProtocolType]: (typeof TEST_CHAIN_NAMES_BY_PROTOCOL)[K][keyof (typeof TEST_CHAIN_NAMES_BY_PROTOCOL)[K]];
}[TestProtocolType];

// Used for tests where we need to access the registry addresses but
// the chain does not support core deployments so we manually fill
// the registry
export const UNSUPPORTED_CHAIN_CORE_ADDRESSES: ChainAddresses = {
  interchainGasPaymaster: 'JAvHW21tYXE9dtdG83DReqU2b4LUexFuCbtJT5tF8X6M',
  interchainSecurityModule: 'Da6Lp9syj8hLRiqjZLTLbZEC1NPhPMPd1JJ3HQRN4NyJ',
  mailbox: 'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi',
  merkleTreeHook: 'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi',
  validatorAnnounce: 'pRgs5vN4Pj7WvFbxf6QDHizo2njq2uksqEUbaSghVA8',
};

export const CORE_CONFIG_PATH_BY_PROTOCOL = {
  [ProtocolType.Ethereum]: `./examples/core-config.yaml`,
  [ProtocolType.CosmosNative]: './examples/cosmosnative/core-config.yaml',
} as const satisfies ProtocolMap<string>;

export const HYP_KEY_BY_PROTOCOL = {
  [ProtocolType.Ethereum]:
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  [ProtocolType.CosmosNative]:
    '33913dd43a5d5764f7a23da212a8664fc4f5eedc68db35f3eb4a5c4f046b5b51',
} as const satisfies ProtocolMap<string>;

export const DEPLOYER_ADDRESS_BY_PROTOCOL = {
  [ProtocolType.Ethereum]: async () =>
    new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
  [ProtocolType.CosmosNative]: async () => {
    const cosmosWallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(HYP_KEY_BY_PROTOCOL.cosmosnative, 'hex'),
      TEST_CHAIN_METADATA_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1.bech32Prefix,
    );
    const [{ address: cosmosNativeDeployerAddress }] =
      await cosmosWallet.getAccounts();

    return cosmosNativeDeployerAddress;
  },
} as const satisfies ProtocolMap<() => Promise<string>>;

type ProtocolChainMap<
  T extends ProtocolMap<{ [key: string]: string }>,
  TValue,
> = {
  [TProtocol in keyof T]: {
    [TChainName in keyof T[TProtocol]]: TValue;
  };
};

type CoreDeploymentPath<TChainName extends string> =
  `${typeof TEMP_PATH}/${TChainName}/core-config-read.yaml`;

export const CORE_READ_CONFIG_PATH_BY_PROTOCOL: ProtocolChainMap<
  typeof TEST_CHAIN_NAMES_BY_PROTOCOL,
  CoreDeploymentPath<TestChainName>
> = Object.fromEntries(
  Object.entries(TEST_CHAIN_NAMES_BY_PROTOCOL).map(([protocol, chainNames]) => [
    protocol,
    Object.fromEntries(
      Object.entries(chainNames).map(([key, name]) => [
        key,
        `${TEMP_PATH}/${name}/core-config-read.yaml`,
      ]),
    ),
  ]),
) as any;

type CoreAddressesPath<TChainName extends string> =
  `${typeof REGISTRY_PATH}/chains/${TChainName}/addresses.yaml`;

export const CORE_ADDRESSES_PATH_BY_PROTOCOL: ProtocolChainMap<
  typeof TEST_CHAIN_NAMES_BY_PROTOCOL,
  CoreAddressesPath<TestChainName>
> = Object.fromEntries(
  Object.entries(TEST_CHAIN_NAMES_BY_PROTOCOL).map(([protocol, chainNames]) => [
    protocol,
    Object.fromEntries(
      Object.entries(chainNames).map(([key, name]) => [
        key,
        `${REGISTRY_PATH}/chains/${name}/addresses.yaml`,
      ]),
    ),
  ]),
) as any;

type TestChainMetadataPath<TChainName extends string> =
  `${typeof REGISTRY_PATH}/chains/${TChainName}/metadata.yaml`;

export const TEST_CHAIN_METADATA_PATH_BY_PROTOCOL: ProtocolChainMap<
  typeof TEST_CHAIN_NAMES_BY_PROTOCOL,
  TestChainMetadataPath<TestChainName>
> = objMap(TEST_CHAIN_NAMES_BY_PROTOCOL, (_protocol, chainNames) => {
  return objMap(
    chainNames,
    (_chainName, name): TestChainMetadataPath<string> =>
      `${REGISTRY_PATH}/chains/${name}/metadata.yaml`,
  );
}) as any;

export type TestChainMetadata = ChainMetadata & {
  rpcPort: number;
  restPort: number;
};

export const TEST_CHAIN_METADATA_BY_PROTOCOL: ProtocolChainMap<
  typeof TEST_CHAIN_NAMES_BY_PROTOCOL,
  TestChainMetadata
> = objMap(TEST_CHAIN_NAMES_BY_PROTOCOL, (protocol, chainNames) => {
  return objMap(chainNames, (chainName, _name): TestChainMetadata => {
    const currentChainMetadata: ChainMetadata = readYamlOrJson(
      TEST_CHAIN_METADATA_PATH_BY_PROTOCOL[protocol][chainName],
    );

    const rpcUrl = currentChainMetadata.rpcUrls[0].http;
    assert(rpcUrl, 'Rpc url is required');
    const rpcPort = parseInt(new URL(rpcUrl).port);

    const restUrl = (currentChainMetadata?.restUrls ?? [])[0]?.http;
    const restPort = restUrl ? parseInt(new URL(restUrl).port) : rpcPort;

    return {
      ...currentChainMetadata,
      rpcPort,
      restPort,
    };
  });
}) as any;

export function getWarpCoreConfigPath(
  tokenSymbol: string,
  chains: string[],
): string {
  return `${REGISTRY_PATH}/deployments/warp_routes/${getWarpId(
    tokenSymbol.toUpperCase(),
    chains,
  )}-config.yaml`;
}

export function getWarpDeployConfigPath(
  tokenSymbol: string,
  chains: string[],
): string {
  return `${REGISTRY_PATH}/deployments/warp_routes/${getWarpId(
    tokenSymbol.toUpperCase(),
    chains,
  )}-deploy.yaml`;
}

export function getWarpId(tokenSymbol: string, chains: string[]): string {
  return createWarpRouteConfigId(
    tokenSymbol.toUpperCase(),
    chains.sort().join('-'),
  );
}

export const E2E_BURN_ADDRESS_BY_PROTOCOL = {
  [ProtocolType.Ethereum]: '0x0000000000000000000000000000000000000001',
  // Result of:
  // bytesToAddressCosmosNative(
  //   addressToBytes(ZERO_ADDRESS_HEX_32),
  //   TEST_CHAIN_METADATA_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1.bech32Prefix,
  // ),
  [ProtocolType.CosmosNative]: 'hyp1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqk98wwq',
} as const satisfies ProtocolMap<string>;

export const TEST_TOKEN_SYMBOL = 'TST';

export const DEFAULT_EVM_WARP_ID = getWarpId('ETH', [
  TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
]);
export const DEFAULT_EVM_WARP_CORE_PATH = getWarpCoreConfigPath('ETH', [
  TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
]);
export const DEFAULT_EVM_WARP_READ_OUTPUT_PATH = getWarpCoreConfigPath('ETH', [
  TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  'read',
]);
export const DEFAULT_EVM_WARP_DEPLOY_PATH = getWarpDeployConfigPath('ETH', [
  TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
]);

export const SUBMITTER_STRATEGY_FILE_PATHS_BY_PROTOCOL = {
  [ProtocolType.Ethereum]: {
    JSON_RPC_ICA_STRATEGY_CONFIG_PATH: `${EXAMPLES_PATH}/submit/strategy/json-rpc-ica-strategy.yaml`,
    JSON_RPC_TIMELOCK_STRATEGY_CONFIG_PATH: `${EXAMPLES_PATH}/submit/strategy/json-rpc-timelock-strategy.yaml`,
  },
} as const satisfies ProtocolMap<Record<string, string>>;
