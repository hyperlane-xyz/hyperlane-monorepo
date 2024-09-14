import { expect } from 'chai';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  ANVIL_KEY,
  REGISTRY_PATH,
  deployOrUseExistingCore,
} from './commands/helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from './commands/warp.js';

const CHAIN_NAME_2 = 'anvil2';

const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
const WARP_CONFIG_PATH_EXAMPLE = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;

const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh
const WARP_CONFIG_PATH_2 = `${TEMP_PATH}/anvil2/warp-route-deployment-anvil2.yaml`;
const WARP_CORE_CONFIG_PATH_2 = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-config.yaml`;

const TEST_TIMEOUT = 60_000; // Long timeout since these tests can take a while
describe('WarpRead e2e tests', async function () {
  let anvil2Config: WarpRouteDeployConfig;
  this.timeout(TEST_TIMEOUT);
  before(async function () {
    await deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY);

    // Create a new warp config using the example
    const exampleWarpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    anvil2Config = { anvil2: { ...exampleWarpConfig.anvil1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2);
  });

  it('should be able to read a warp route', async function () {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );
    expect(warpConfig[CHAIN_NAME_2].type).to.be.equal(
      anvil2Config[CHAIN_NAME_2].type,
    );
  });
});
