import { readFileSync, writeFileSync } from 'fs';

import { expect } from 'chai';
import { Wallet } from 'ethers';
import { $ } from 'zx';

import { type XERC20VSTest } from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
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
import { deployXERC20VSToken } from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  getCombinedWarpDeployPath,
  getCombinedWarpRoutePath,
  getWarpRouteId,
} from '../consts.js';

$.verbose = true;

describe('hyperlane warp xERC20 token fee e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const TOKEN_SYMBOL = 'XFEE';
  const WARP_ROUTE_ID = getWarpRouteId(TOKEN_SYMBOL, [CHAIN_NAME_2]);
  const CORE_PATH = getCombinedWarpRoutePath(TOKEN_SYMBOL, [CHAIN_NAME_2]);
  const REGISTRY_DEPLOY_PATH = getCombinedWarpDeployPath(TOKEN_SYMBOL, [
    CHAIN_NAME_2,
  ]);
  const DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-fee-deploy.yaml`;

  const FEE_BPS = 100;

  let chain2Addresses: ChainAddresses;
  let ownerAddress: Address;
  let xerc20: XERC20VSTest;
  let originalChain2MetadataYaml: string;

  before(async function () {
    // The xERC20 reader derives extra-lockbox configs from the block explorer
    // on every read; the local anvil explorer is a stub, so strip it. XERC20VS
    // tokens have no extra lockboxes, so derived extraBridges is [] regardless.
    originalChain2MetadataYaml = readFileSync(CHAIN_2_METADATA_PATH, 'utf8');
    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    writeYamlOrJson(CHAIN_2_METADATA_PATH, {
      ...chain2Metadata,
      blockExplorers: [],
    });

    chain2Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_2,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );
    ownerAddress = new Wallet(ANVIL_KEY).address;
    xerc20 = await deployXERC20VSToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      18,
      TOKEN_SYMBOL,
    );
  });

  after(function () {
    writeFileSync(CHAIN_2_METADATA_PATH, originalChain2MetadataYaml);
  });

  function buildConfig(bps?: number): WarpRouteDeployConfig {
    return WarpRouteDeployConfigSchema.parse({
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20,
        token: xerc20.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
        ...(bps != null
          ? { tokenFee: { type: TokenFeeType.LinearFee, bps } }
          : {}),
      },
    });
  }

  it('deploys an xERC20 warp route with a LinearFee', async function () {
    writeYamlOrJson(DEPLOY_PATH, buildConfig(FEE_BPS));
    await hyperlaneWarpDeploy(DEPLOY_PATH, WARP_ROUTE_ID);

    const config = (
      await readWarpConfig(CHAIN_NAME_2, CORE_PATH, REGISTRY_DEPLOY_PATH)
    )[CHAIN_NAME_2];

    expect(config.tokenFee).to.exist;
    expect(config.tokenFee?.type).to.equal(TokenFeeType.LinearFee);
    expect(
      config.tokenFee && 'bps' in config.tokenFee
        ? config.tokenFee.bps
        : undefined,
    ).to.equal(FEE_BPS);
    // For xERC20 the fee token resolves to the wrapped/collateral token.
    expect(
      config.tokenFee && 'token' in config.tokenFee
        ? config.tokenFee.token
        : undefined,
    ).to.equal(xerc20.address);
  });

  describe('setting a fee on an existing xERC20 warp route via warp apply', () => {
    // The global e2e beforeEach wipes deployments/warp_routes before every
    // test, so re-deploy a fee-less route here (mirrors warp-extend-basic).
    beforeEach(async function () {
      writeYamlOrJson(DEPLOY_PATH, buildConfig());
      await hyperlaneWarpDeploy(DEPLOY_PATH, WARP_ROUTE_ID);
    });

    it('sets a LinearFee on a fee-less xERC20 warp route', async function () {
      const deployedConfig = (
        await readWarpConfig(CHAIN_NAME_2, CORE_PATH, REGISTRY_DEPLOY_PATH)
      )[CHAIN_NAME_2];
      expect(deployedConfig.tokenFee).to.be.undefined;

      // warp apply reads the desired config from the registry deploy path.
      writeYamlOrJson(REGISTRY_DEPLOY_PATH, buildConfig(FEE_BPS));
      await hyperlaneWarpApply(WARP_ROUTE_ID);

      const updatedConfig = (
        await readWarpConfig(CHAIN_NAME_2, CORE_PATH, REGISTRY_DEPLOY_PATH)
      )[CHAIN_NAME_2];

      expect(updatedConfig.tokenFee).to.exist;
      expect(updatedConfig.tokenFee?.type).to.equal(TokenFeeType.LinearFee);
      expect(
        updatedConfig.tokenFee && 'bps' in updatedConfig.tokenFee
          ? updatedConfig.tokenFee.bps
          : undefined,
      ).to.equal(FEE_BPS);
      // For xERC20 the fee token resolves to the wrapped/collateral token.
      expect(
        updatedConfig.tokenFee && 'token' in updatedConfig.tokenFee
          ? updatedConfig.tokenFee.token
          : undefined,
      ).to.equal(xerc20.address);
    });
  });
});
