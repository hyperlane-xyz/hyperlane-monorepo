import { readFileSync, writeFileSync } from 'fs';

import { expect } from 'chai';
import { Wallet } from 'ethers';
import { $ } from 'zx';

import { type XERC20LockboxTest, type XERC20VSTest } from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  TokenFeeConfigSchema,
  TokenFeeType,
  TokenType,
  type WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  assert,
  eqAddress,
  isNullish,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  deployToken,
  deployXERC20LockboxToken,
  deployXERC20VSToken,
} from '../commands/helpers.js';
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
        ...(isNullish(bps)
          ? {}
          : { tokenFee: { type: TokenFeeType.LinearFee, bps } }),
      },
    });
  }

  it('deploys an xERC20 warp route with a LinearFee', async function () {
    writeYamlOrJson(DEPLOY_PATH, buildConfig(FEE_BPS));
    await hyperlaneWarpDeploy(DEPLOY_PATH, WARP_ROUTE_ID);

    const config = (
      await readWarpConfig(CHAIN_NAME_2, CORE_PATH, REGISTRY_DEPLOY_PATH)
    )[CHAIN_NAME_2];

    const fee = TokenFeeConfigSchema.parse(config.tokenFee);
    assert(fee.type === TokenFeeType.LinearFee, 'expected a LinearFee');
    expect(fee.bps).to.equal(FEE_BPS);
    // For xERC20 the fee token resolves to the wrapped/collateral token.
    expect(fee.token).to.equal(xerc20.address);
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

      const fee = TokenFeeConfigSchema.parse(updatedConfig.tokenFee);
      assert(fee.type === TokenFeeType.LinearFee, 'expected a LinearFee');
      expect(fee.bps).to.equal(FEE_BPS);
      // For xERC20 the fee token resolves to the wrapped/collateral token.
      expect(fee.token).to.equal(xerc20.address);
    });
  });

  // Regression for the xERC20Lockbox fee-token resolution bug: the deploy
  // config stores token = lockbox address, but the router's token()/feeToken()
  // returns the underlying wrapped ERC20. The fee contract must be deployed
  // with token() so the router's fee==token() check passes; the SDK reads this
  // on-chain for the lockbox variant.
  describe('xERC20Lockbox token fee', () => {
    const LB_SYMBOL = 'XLBFEE';
    const LB_WARP_ROUTE_ID = getWarpRouteId(LB_SYMBOL, [CHAIN_NAME_2]);
    const LB_CORE_PATH = getCombinedWarpRoutePath(LB_SYMBOL, [CHAIN_NAME_2]);
    const LB_REGISTRY_DEPLOY_PATH = getCombinedWarpDeployPath(LB_SYMBOL, [
      CHAIN_NAME_2,
    ]);
    const LB_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20lockbox-fee-deploy.yaml`;

    let lockbox: XERC20LockboxTest;
    let wrappedToken: Address;

    before(async function () {
      const underlying = await deployToken(
        ANVIL_KEY,
        CHAIN_NAME_2,
        18,
        LB_SYMBOL,
      );
      lockbox = await deployXERC20LockboxToken(
        ANVIL_KEY,
        CHAIN_NAME_2,
        underlying,
      );
      // The lockbox exposes its underlying wrapped ERC20 via ERC20().
      wrappedToken = await lockbox.ERC20();
    });

    function buildLockboxConfig(bps?: number): WarpRouteDeployConfig {
      return WarpRouteDeployConfigSchema.parse({
        [CHAIN_NAME_2]: {
          type: TokenType.XERC20Lockbox,
          token: lockbox.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          ...(isNullish(bps)
            ? {}
            : { tokenFee: { type: TokenFeeType.LinearFee, bps } }),
        },
      });
    }

    it('deploys an xERC20Lockbox warp route with a LinearFee resolved to the wrapped token', async function () {
      writeYamlOrJson(LB_DEPLOY_PATH, buildLockboxConfig(FEE_BPS));
      await hyperlaneWarpDeploy(LB_DEPLOY_PATH, LB_WARP_ROUTE_ID);

      const config = (
        await readWarpConfig(
          CHAIN_NAME_2,
          LB_CORE_PATH,
          LB_REGISTRY_DEPLOY_PATH,
        )
      )[CHAIN_NAME_2];

      const fee = TokenFeeConfigSchema.parse(config.tokenFee);
      assert(fee.type === TokenFeeType.LinearFee, 'expected a LinearFee');
      expect(fee.bps).to.equal(FEE_BPS);
      // The fee token must be the underlying wrapped ERC20 (router.token()),
      // NOT the lockbox address stored in the deploy config.
      expect(eqAddress(fee.token, wrappedToken)).to.be.true;
      expect(eqAddress(fee.token, lockbox.address)).to.be.false;
    });

    describe('setting a fee on an existing xERC20Lockbox warp route via warp apply', () => {
      // The global e2e beforeEach wipes deployments/warp_routes before every
      // test, so re-deploy a fee-less lockbox route here.
      beforeEach(async function () {
        writeYamlOrJson(LB_DEPLOY_PATH, buildLockboxConfig());
        await hyperlaneWarpDeploy(LB_DEPLOY_PATH, LB_WARP_ROUTE_ID);
      });

      it('sets a LinearFee on a fee-less xERC20Lockbox warp route', async function () {
        const deployedConfig = (
          await readWarpConfig(
            CHAIN_NAME_2,
            LB_CORE_PATH,
            LB_REGISTRY_DEPLOY_PATH,
          )
        )[CHAIN_NAME_2];
        expect(deployedConfig.tokenFee).to.be.undefined;

        // warp apply reads the desired config from the registry deploy path.
        writeYamlOrJson(LB_REGISTRY_DEPLOY_PATH, buildLockboxConfig(FEE_BPS));
        await hyperlaneWarpApply(LB_WARP_ROUTE_ID);

        const updatedConfig = (
          await readWarpConfig(
            CHAIN_NAME_2,
            LB_CORE_PATH,
            LB_REGISTRY_DEPLOY_PATH,
          )
        )[CHAIN_NAME_2];

        const fee = TokenFeeConfigSchema.parse(updatedConfig.tokenFee);
        assert(fee.type === TokenFeeType.LinearFee, 'expected a LinearFee');
        expect(fee.bps).to.equal(FEE_BPS);
        // The applied fee token must resolve to the wrapped ERC20 (router.token()),
        // NOT the lockbox address stored in the deploy config.
        expect(eqAddress(fee.token, wrappedToken)).to.be.true;
        expect(eqAddress(fee.token, lockbox.address)).to.be.false;
      });
    });
  });
});
