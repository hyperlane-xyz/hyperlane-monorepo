import { expect } from 'chai';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  deployOrUseExistingCore,
} from './commands/helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from './commands/warp.js';

describe('hyperlane warp read e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let anvil2Config: WarpRouteDeployConfig;

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
