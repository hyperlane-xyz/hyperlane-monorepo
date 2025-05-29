import { $ } from 'zx';

// import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

// import { readYamlOrJson } from '../utils/files.js';

import { DEFAULT_E2E_TEST_TIMEOUT } from './commands/helpers.js';
import { localTestRunCmdPrefix } from './commands/helpers.js';
import { hyperlaneWarpApply } from './commands/warp.js';

describe('hyperlane warp apply upgrade tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  before(async function () {});

  beforeEach(async function () {
    console.log('beforeEach');
  });

  it('foobar', async () => {
    // Fork
    const anvilProcess = $`${localTestRunCmdPrefix()} hyperlane registry fork \
        --name ethereum`;
    process.once('exit', () => anvilProcess.kill());

    // Get config
    const warpConfigPath = './examples/warp-route-config-with-version.yaml';
    // const warpConfig: WarpRouteDeployConfig =
    //   await readYamlOrJson(warpConfigPath);

    // Set to undefined if it was defined in the config
    //   warpConfig.anvil1.proxyAdmin = undefined;
    //   warpConfig.anvil1.owner = E2E_TEST_BURN_ADDRESS;
    //   const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    //   writeYamlOrJson(warpConfigPath, anvil2Config);

    await hyperlaneWarpApply(warpConfigPath, warpConfigPath);

    // Verify the package version was updated correctly
  });
});
