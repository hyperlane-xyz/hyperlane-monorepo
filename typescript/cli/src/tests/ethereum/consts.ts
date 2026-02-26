import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';

// Test stack selection via environment variable (default: anvil)
const TEST_STACK = process.env.TEST_STACK || 'anvil';

export const E2E_TEST_CONFIGS_PATH = './test-configs';

// Registry path switches based on test stack
export const REGISTRY_PATH =
  TEST_STACK === 'tron'
    ? `${E2E_TEST_CONFIGS_PATH}/tron`
    : `${E2E_TEST_CONFIGS_PATH}/anvil`;

export const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

// Key switches based on test stack
export const ANVIL_KEY =
  TEST_STACK === 'tron'
    ? '0xb5a4cea271ff424d7c31dc12a3e43e401df7a40d7412a15750f3f0b6b5449a28'
    : '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const ANVIL_DEPLOYER_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const E2E_TEST_BURN_ADDRESS =
  '0x0000000000000000000000000000000000000001';
export const COINGECKO_API_KEY = 'CG-Gmk12Pz3A4L9qR5XtV7Kd8N3';

// Chain names stay the same - Tron registry uses anvil2/3/4 aliases
export const CHAIN_NAME_2 = 'anvil2';
export const CHAIN_NAME_3 = 'anvil3';
export const CHAIN_NAME_4 = 'anvil4';

export const EXAMPLES_PATH = './examples';
export const CORE_CONFIG_PATH =
  TEST_STACK === 'tron'
    ? `${EXAMPLES_PATH}/tron-core-config.yaml`
    : `${EXAMPLES_PATH}/core-config.yaml`;
export const CORE_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config.yaml`;
export const CORE_READ_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/core-config-read.yaml`;
export const CORE_READ_CONFIG_PATH_3 = `${TEMP_PATH}/${CHAIN_NAME_3}/core-config-read.yaml`;
export const CHAIN_2_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`;
export const CHAIN_3_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_3}/metadata.yaml`;
export const CHAIN_4_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_4}/metadata.yaml`;

export const WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
export const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/${CHAIN_NAME_2}/warp-route-deployment-anvil2.yaml`;
export const WARP_DEPLOY_DEFAULT_FILE_NAME = `warp-route-deployment`;
export const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/${WARP_DEPLOY_DEFAULT_FILE_NAME}.yaml`;
export const WARP_DEPLOY_2_ID = 'ETH/anvil2';
export const WARP_CORE_CONFIG_PATH_2 = getCombinedWarpRoutePath('ETH', [
  CHAIN_NAME_2,
]);

export const WARP_DEPLOY_CONFIG_PATH_2 = getCombinedWarpDeployPath('ETH', [
  CHAIN_NAME_2,
]);

export const REBALANCER_CONFIG_PATH = `${TEMP_PATH}/rebalancer-config.json`;

export const WARP_DEPLOY_CONFIG_CHAIN_2 = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
export const WARP_DEPLOY_CONFIG_CHAIN_3 = `${TEMP_PATH}/warp-route-deployment-3.yaml`;

export const JSON_RPC_ICA_STRATEGY_CONFIG_PATH = `${EXAMPLES_PATH}/submit/strategy/json-rpc-ica-strategy.yaml`;
export const JSON_RPC_TIMELOCK_STRATEGY_CONFIG_PATH = `${EXAMPLES_PATH}/submit/strategy/json-rpc-timelock-strategy.yaml`;

// Timeout switches based on test stack (Tron is slower)
export const DEFAULT_E2E_TEST_TIMEOUT =
  TEST_STACK === 'tron' ? 180_000 : 100_000;

// Deterministic TRE keys derived from BIP-44 m/44'/195'/0'/0/N
// Mnemonic: abandon abandon abandon abandon abandon abandon abandon about
// Key 0 = ANVIL_KEY for tron. Keys 1-2 used as separate deployers to avoid
// "Dup transaction" errors when deploying identical core contracts in parallel.
export const TRON_KEY_1 =
  '0xedb728e259afca2ddcc428459e7681b8414668649aedbc8d25c0872da219b2e6';
export const TRON_KEY_2 =
  '0x0e5684898be2d272d54eb2be3fd41a12f720db6358cee02c2d23043eed4bf7a2';

// Export test stack for conditional logic in setup
export const IS_TRON_TEST = TEST_STACK === 'tron';

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
