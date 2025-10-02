import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import { ProtocolMap } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

export const DEFAULT_E2E_TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while

export const E2E_TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${E2E_TEST_CONFIGS_PATH}/test-registry`;
export const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

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
} as const satisfies ProtocolMap<Record<string, string>>;

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

type CoreDeploymentPath<T extends string> =
  `${typeof TEMP_PATH}/${T}/core-config-read.yaml`;
type CoreReadPathByProtocolAndChain<
  T extends ProtocolMap<{ [key: string]: string }>,
> = {
  [TProtocol in keyof T]: {
    [TChainName in keyof T[TProtocol]]: CoreDeploymentPath<
      T[TProtocol][TChainName] & string
    >;
  };
};

export const CORE_READ_CONFIG_PATH_BY_PROTOCOL: CoreReadPathByProtocolAndChain<
  typeof TEST_CHAIN_NAMES_BY_PROTOCOL
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

export function getCombinedWarpRoutePath(
  tokenSymbol: string,
  chains: string[],
): string {
  return `${REGISTRY_PATH}/deployments/warp_routes/${createWarpRouteConfigId(
    tokenSymbol.toUpperCase(),
    chains.sort().join('-'),
  )}-config.yaml`;
}
