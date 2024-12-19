import { expect } from 'chai';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { ZKSYNC_KEY, deployOrUseExistingCore } from './commands/helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from './commands/warp.js';

const CHAIN_NAME_ZK_2 = 'zksync2';

export const TEST_CONFIGS_PATH = './test-configs';
export const ZK_REGISTRY_PATH = `${TEST_CONFIGS_PATH}/zksync`;

const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config-zksync.yaml`;
const WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;

const TEMP_PATH = '/tmp'; // temp gets removed at the end of all-test.sh
const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/zksync/warp-route-deployment.yaml`;
const WARP_CORE_CONFIG_PATH_2 = `${ZK_REGISTRY_PATH}/deployments/warp_routes/ETH/${CHAIN_NAME_ZK_2}-config.yaml`;

const TEST_TIMEOUT = 180_000; // Long timeout since these tests can take a while
describe.skip('WarpRead ZKSync e2e tests', async function () {
  let zksync2WarpConfig: WarpRouteDeployConfig;
  this.timeout(TEST_TIMEOUT);
  before(async function () {
    await deployOrUseExistingCore(
      CHAIN_NAME_ZK_2,
      CORE_CONFIG_PATH,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );

    // Create a new warp config using the example
    const exampleWarpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    zksync2WarpConfig = { zksync2: { ...exampleWarpConfig.anvil1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_2, zksync2WarpConfig);
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2, ZKSYNC_KEY, ZK_REGISTRY_PATH);
  });

  it('should be able to read a warp route', async function () {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpConfig = await readWarpConfig(
      CHAIN_NAME_ZK_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
      ZKSYNC_KEY,
      ZK_REGISTRY_PATH,
    );
    expect(warpConfig[CHAIN_NAME_ZK_2].type).to.be.equal(
      zksync2WarpConfig[CHAIN_NAME_ZK_2].type,
    );
  });
});
