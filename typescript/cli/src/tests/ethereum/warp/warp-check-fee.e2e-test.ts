import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';

import { type ERC20Test } from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  TokenFeeType,
  TokenType,
  type WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployToken } from '../commands/helpers.js';
import {
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp check fee e2e tests', async function () {
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

    const chainMetadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);

    new ethers.providers.JsonRpcProvider(chainMetadata.rpcUrls[0].http);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    tokenSymbol = await token.symbol();

    combinedWarpCoreConfigPath = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_3,
    ]);
  });

  async function deployAndExportWarpRoute(): Promise<WarpRouteDeployConfig> {
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
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

  describe('tokenFee bps comparison', () => {
    it('should pass warp check when LinearFee bps matches (no maxFee/halfAmount violations)', async function () {
      const bpsValue = 100n;

      warpConfig = WarpRouteDeployConfigSchema.parse({
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          tokenFee: {
            type: TokenFeeType.LinearFee,
            owner: ownerAddress,
            bps: bpsValue,
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      });

      await deployAndExportWarpRoute();

      const currentWarpId = createWarpRouteConfigId(
        await token.symbol(),
        CHAIN_NAME_3,
      );

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
      }).nothrow();

      expect(output.text()).to.not.include('maxFee');
      expect(output.text()).to.not.include('halfAmount');

      if (output.exitCode !== 0) {
        expect(output.text()).to.not.include('tokenFee');
      }
    });

    it('should pass warp check when RoutingFee with nested LinearFee bps matches', async function () {
      const bpsValue = 50n;

      warpConfig = WarpRouteDeployConfigSchema.parse({
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          tokenFee: {
            type: TokenFeeType.RoutingFee,
            owner: ownerAddress,
            feeContracts: {
              [CHAIN_NAME_3]: {
                type: TokenFeeType.LinearFee,
                owner: ownerAddress,
                bps: bpsValue,
              },
            },
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      });

      await deployAndExportWarpRoute();

      const currentWarpId = createWarpRouteConfigId(
        await token.symbol(),
        CHAIN_NAME_3,
      );

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
      }).nothrow();

      expect(output.text()).to.not.include('maxFee');
      expect(output.text()).to.not.include('halfAmount');

      if (output.exitCode !== 0) {
        expect(output.text()).to.not.include('feeContracts');
      }
    });
  });
});
