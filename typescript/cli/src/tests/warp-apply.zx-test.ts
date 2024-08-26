import { expect } from 'chai';
import { beforeEach } from 'mocha';
import path from 'path';

import { updateWarpOwner } from './commands/helpers.js';
import {
  REGISTRY_PATH, // hyperlaneCoreDeploy,
  hyperlaneWarpApply, // hyperlaneWarpApply,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from './commands/warp.js';

/// To run: 1) start an anvil, 2) yarn run tsx tests/warp.zs-test.ts inside of cli/

const BURN_ADDRESS = '0x0000000000000000000000000000000000000001';
const EXAMPLES_PATH = './examples';
// const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
const WARP_CONFIG_PATH = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil1-config.yaml`;

describe('WarpApply', function () {
  this.timeout(0); // No limit timeout since these tests can take a while

  beforeEach(async function () {
    console.log(path.dirname(EXAMPLES_PATH));
    // await hyperlaneCoreDeploy(CORE_CONFIG_PATH);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);
  });
  it('should burn owner address', async function () {
    const warpConfigPath = `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`;
    const newPath = await updateWarpOwner(
      BURN_ADDRESS,
      WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    await hyperlaneWarpApply(newPath, WARP_CORE_CONFIG_PATH);
    const updatedWarpDeployConfig = await readWarpConfig(
      WARP_CORE_CONFIG_PATH,
      warpConfigPath,
    );
    console.log('updatedWarpDeployConfig', updatedWarpDeployConfig);
    expect(updatedWarpDeployConfig.anvil1.owner).to.equal(BURN_ADDRESS);
  });
});
