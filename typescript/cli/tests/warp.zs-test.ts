import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from 'ethers';
import { $ } from 'zx';

import { WarpCoreConfig, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { Address, assert, eqAddress } from '@hyperlane-xyz/utils';

import { HypNative__factory } from '../../../solidity/dist/factories/contracts/token/HypNative__factory.js';
import { readYamlOrJson, writeYamlOrJson } from '../src/utils/files.js';

/// To run: 1) start an anvil, 2) yarn run tsx tests/warp.zs-test.ts inside of cli/

const BURN_ADDRESS = '0x0000000000000000000000000000000000000001';
const LOCAL_ANVIL_HOST = 'http://localhost:8545';
const CHAIN_NAME = 'anvil1';
const EXAMPLES_PATH = './examples';
const TEST_CONFIGS_PATH = './test-configs';
const REGISTRY_PATH = `${TEST_CONFIGS_PATH}/anvil`;
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
const WARP_CONFIG_PATH = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil1-config.yaml`;

const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Deploys the Hyperlane core contracts to the specified chain using the provided config.
 */
async function hyperlaneCoreDeploy(coreInputPath: string) {
  await $`yarn workspace @hyperlane-xyz/cli run hyperlane core deploy \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${coreInputPath} \
        --chain ${CHAIN_NAME} \
        --key ${ANVIL_KEY} \
        --yes`;
}

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
async function hyperlaneWarpDeploy(warpCoreInputPath: string) {
  await $`yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${warpCoreInputPath} \
        --key ${ANVIL_KEY} \
        --yes`;
}

/**
 * Retrieves the deployed Warp address from the Warp core config.
 * @param warpCorePath - The file path to the Warp core config.
 * @returns The deployed Warp address.
 */
function getDeployedWarpAddress(warpCorePath: string) {
  const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
  return warpCoreConfig.tokens[0].addressOrDenom;
}

/**
 * Reads the Warp route deployment config to specified output path.
 * @returns The Warp route deployment config.
 */
async function readWarpConfig(
  warpCoreInputPath: string,
  warpDeployOutputPath: string,
): Promise<WarpRouteDeployConfig> {
  const warpAddress = getDeployedWarpAddress(warpCoreInputPath);

  await $`yarn workspace @hyperlane-xyz/cli run hyperlane warp read \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --address ${warpAddress} \
        --chain ${CHAIN_NAME} \
        --config ${warpDeployOutputPath}`;
  return readYamlOrJson(warpDeployOutputPath);
}

/**
 * Updates the owner of the Warp route deployment config, and then output to a file
 * @returns The file path to the updated Warp route deployment config.
 */
async function updateWarpOwner(
  owner: Address,
  warpCoreInputPath: string,
  warpDeployOutputPath: string,
): Promise<string> {
  const warpDeployConfig = await readWarpConfig(
    warpCoreInputPath,
    warpDeployOutputPath,
  );
  warpDeployConfig[CHAIN_NAME].owner = owner;
  writeYamlOrJson(warpDeployOutputPath, warpDeployConfig);

  return warpDeployOutputPath;
}

async function hyperlaneWarpApply(
  warpDeployPath: string,
  warpCorePath: string,
) {
  await $`yarn workspace @hyperlane-xyz/cli run hyperlane warp apply \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${warpDeployPath} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --yes`;
}

async function checkWarpOwner() {
  const warpAddress = getDeployedWarpAddress(WARP_CORE_CONFIG_PATH);
  const provider = new JsonRpcProvider(LOCAL_ANVIL_HOST);
  const signer = new Wallet(ANVIL_KEY, provider);
  const hypNative = HypNative__factory.connect(warpAddress!, signer);
  const owner = await hypNative.owner();
  assert(
    eqAddress(owner, BURN_ADDRESS),
    'Warp Apply did not set owner to address zero',
  );

  // TODO: Consider using logger
  console.log(`Successfully burned owner to ${BURN_ADDRESS}`);
}

await hyperlaneCoreDeploy(CORE_CONFIG_PATH);
await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

const warpConfigPath = await updateWarpOwner(
  BURN_ADDRESS,
  WARP_CORE_CONFIG_PATH,
  `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`,
);
await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH);

await checkWarpOwner();
