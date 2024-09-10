import { TokenType } from '@hyperlane-xyz/sdk';

import { writeYamlOrJson } from '../utils/files.js';

import { ANVIL_KEY, deployOrUseExistingCore } from './commands/helpers.js';
import { hyperlaneWarpDeploy } from './commands/warp.js';

const CHAIN_NAME_2 = 'anvil2';
const CHAIN_NAME_3 = 'anvil3';

const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;

const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

const TEST_TIMEOUT = 60_000; // Long timeout since these tests can take a while
describe('WarpDeploy e2e tests', async function () {
  // let chain2Addresses: ChainAddresses = {};
  this.timeout(TEST_TIMEOUT);
  before(async function () {
    await deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY);
    await deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY);

    // // Create a new warp config using the example
    // const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
    //   WARP_CONFIG_PATH_EXAMPLE,
    // );
    // const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    // writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);
  });

  it.only('should only allow rebasing yield route to be deployed with rebasing synthetic', async function () {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateralVaultRebase,
        token: '',
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        token: '',
      },
    };

    writeYamlOrJson(warpConfigPath, warpConfig);
    await hyperlaneWarpDeploy(warpConfigPath);
  });

  // it('should deploy a rebasing yield route', async function () {
  //   // Create a yield route config
  //   // Deploy it
  //   // Check
  // });
});
