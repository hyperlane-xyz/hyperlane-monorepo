import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';

export const E2E_TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${E2E_TEST_CONFIGS_PATH}/hyp`;
export const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

export const HYP_KEY =
  '33913dd43a5d5764f7a23da212a8664fc4f5eedc68db35f3eb4a5c4f046b5b51';

export const EXAMPLES_PATH = './examples/cosmosnative';

export const CHAIN_NAME_1 = 'hyp1';
export const CHAIN_NAME_2 = 'hyp2';
export const CHAIN_NAME_3 = 'hyp3';

export const CHAIN_1_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_1}/metadata.yaml`;
export const CHAIN_2_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`;
export const CHAIN_3_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_3}/metadata.yaml`;

export const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;

export const CORE_READ_CONFIG_PATH_1 = `${TEMP_PATH}/${CHAIN_NAME_1}/core-config-read.yaml`;
export const CORE_READ_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config-read.yaml`;
export const CORE_READ_CONFIG_PATH_3 = `${TEMP_PATH}/${CHAIN_NAME_3}/core-config-read.yaml`;

export const DEFAULT_E2E_TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while

export const WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;

export const WARP_CONFIG_PATH_1 = `${TEMP_PATH}/${CHAIN_NAME_1}/warp-route-deployment-hyp1.yaml`;
export const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/warp-route-deployment-hyp2.yaml`;
export const WARP_CONFIG_PATH_3 = `${TEMP_PATH}/${CHAIN_NAME_3}/warp-route-deployment-hyp3.yaml`;

export const WARP_DEPLOY_DEFAULT_FILE_NAME = `warp-route-deployment`;
export const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/${WARP_DEPLOY_DEFAULT_FILE_NAME}.yaml`;

export const WARP_DEPLOY_1_ID = 'TEST/hyp1';
export const WARP_CORE_CONFIG_PATH_1 = getCombinedWarpRoutePath('TEST', [
  CHAIN_NAME_1,
]);

export function getCombinedWarpRoutePath(
  tokenSymbol: string,
  chains: string[],
): string {
  return `${REGISTRY_PATH}/deployments/warp_routes/${createWarpRouteConfigId(
    tokenSymbol.toUpperCase(),
    chains.sort().join('-'),
  )}-config.yaml`;
}
