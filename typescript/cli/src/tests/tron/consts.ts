import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';

export const E2E_TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${E2E_TEST_CONFIGS_PATH}/test-registry`;
export const TEMP_PATH = '/tmp';

// Test account from local-node/conf/config.conf genesis
// Tron address: TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY
export const TRON_KEY =
  'da146374a75310b9666e834ee4ad0866d6f4035967bfc76217c5a495fff9f0d0';
// EVM-compatible hex address derived from the Tron key
export const TRON_DEPLOYER_ADDRESS =
  '0x970BF2D2a8691BB27D9b7A7c32B3DdF7a8Cac3F8';
export const E2E_TEST_BURN_ADDRESS =
  '0x0000000000000000000000000000000000000001';

export const CHAIN_NAME_1 = 'tron1';
export const CHAIN_NAME_2 = 'tron2';

// Reuse ethereum example configs (same format works for TechnicalStack approach)
export const EXAMPLES_PATH = './examples';
export const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
export const CORE_CONFIG_PATH_1 = `${TEMP_PATH}/${CHAIN_NAME_1}/core-config.yaml`;
export const CORE_READ_CONFIG_PATH_1 = `${TEMP_PATH}/${CHAIN_NAME_1}/core-config-read.yaml`;
export const CORE_READ_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config-read.yaml`;
export const CHAIN_1_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_1}/metadata.yaml`;
export const CHAIN_2_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`;

export const WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
export const WARP_CONFIG_PATH_1 = `${TEMP_PATH}/${CHAIN_NAME_1}/warp-route-deployment-tron1.yaml`;
export const WARP_DEPLOY_DEFAULT_FILE_NAME = `warp-route-deployment`;
export const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/${WARP_DEPLOY_DEFAULT_FILE_NAME}.yaml`;
export const WARP_DEPLOY_1_ID = 'TRX/tron1';
export const WARP_CORE_CONFIG_PATH_1 = getCombinedWarpRoutePath('TRX', [
  CHAIN_NAME_1,
]);

export const WARP_DEPLOY_CONFIG_PATH_1 = getCombinedWarpDeployPath('TRX', [
  CHAIN_NAME_1,
]);

export const WARP_DEPLOY_CONFIG_CHAIN_1 = `${TEMP_PATH}/warp-route-deployment-1.yaml`;
export const WARP_DEPLOY_CONFIG_CHAIN_2 = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

// Tron nodes take longer to start and deploy
export const DEFAULT_E2E_TEST_TIMEOUT = 180_000;

export function getCombinedWarpRoutePath(
  tokenSymbol: string,
  chains: string[],
): string {
  return `${REGISTRY_PATH}/deployments/warp_routes/${createWarpRouteConfigId(
    tokenSymbol.toUpperCase(),
    chains.sort().join('-'),
  )}-config.yaml`;
}

export function getCombinedWarpDeployPath(
  tokenSymbol: string,
  chains: string[],
): string {
  return `${REGISTRY_PATH}/deployments/warp_routes/${createWarpRouteConfigId(
    tokenSymbol.toUpperCase(),
    chains.sort().join('-'),
  )}-deploy.yaml`;
}
