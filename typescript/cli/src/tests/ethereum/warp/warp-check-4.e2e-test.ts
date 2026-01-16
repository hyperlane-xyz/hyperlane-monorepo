import { expect } from 'chai';
import { Wallet } from 'ethers';

import { type ERC20Test } from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type HookConfig,
  MUTABLE_HOOK_TYPE,
  TokenType,
  type WarpRouteDeployConfig,
  randomAddress,
  randomHookConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, deepCopy } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployToken } from '../commands/helpers.js';
import {
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: ERC20Test;
  let tokenSymbol: string;
  let ownerAddress: Address;
  let combinedWarpCoreConfigPath: string;
  let warpConfig: WarpRouteDeployConfig;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    tokenSymbol = await token.symbol();

    combinedWarpCoreConfigPath = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_3,
    ]);
  });

  async function deployAndExportWarpRoute(): Promise<WarpRouteDeployConfig> {
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    // currently warp deploy is not writing the deploy config to the registry
    // should remove this once the deploy config is written to the registry
    writeYamlOrJson(
      combinedWarpCoreConfigPath.replace('-config.yaml', '-deploy.yaml'),
      warpConfig,
    );

    const currentWarpId = createWarpRouteConfigId(
      await token.symbol(),
      CHAIN_NAME_3,
    );

    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, currentWarpId);

    return warpConfig;
  }

  // Reset config before each test to avoid test changes intertwining
  beforeEach(async function () {
    ownerAddress = new Wallet(ANVIL_KEY).address;
    warpConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: token.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };
  });

  for (const hookType of MUTABLE_HOOK_TYPE) {
    it(`should find owner differences between the local config and the on chain config for hook of type ${hookType}`, async function () {
      warpConfig[CHAIN_NAME_3].hook = randomHookConfig(0, 2, hookType);
      await deployAndExportWarpRoute();

      const mutatedWarpConfig = deepCopy(warpConfig);

      const hookConfig: Extract<
        HookConfig,
        { type: (typeof MUTABLE_HOOK_TYPE)[number]; owner: string }
      > = mutatedWarpConfig[CHAIN_NAME_3].hook!;
      const actualOwner = hookConfig.owner;
      const wrongOwner = randomAddress();
      assert(actualOwner !== wrongOwner, 'Random owner matches actualOwner');
      hookConfig.owner = wrongOwner;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, mutatedWarpConfig);

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${actualOwner.toLowerCase()}"\n`;

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();
      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  }
});
