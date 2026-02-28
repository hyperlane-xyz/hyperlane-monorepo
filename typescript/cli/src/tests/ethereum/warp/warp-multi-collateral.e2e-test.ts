import { expect } from 'chai';
import { parseUnits } from 'ethers/lib/utils.js';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type Token,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployToken } from '../commands/helpers.js';
import {
  hyperlaneWarpApplyRaw,
  hyperlaneWarpCombine,
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  REGISTRY_PATH,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp multiCollateral CLI e2e tests', async function () {
  this.timeout(300_000);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  const ownerAddress = ANVIL_DEPLOYER_ADDRESS;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
  });

  it('should send cross-stablecoin transfer via CLI warp send (USDC -> USDT cross-chain)', async function () {
    // Deploy USDC(6dec) + USDT(18dec) on both chains
    const usdcChain2 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      6,
      'CUSDC',
      'CLI USDC',
    );
    const usdtChain2 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      18,
      'CUSDT',
      'CLI USDT',
    );
    const usdcChain3 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_3,
      6,
      'CUSDC',
      'CLI USDC',
    );
    const usdtChain3 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_3,
      18,
      'CUSDT',
      'CLI USDT',
    );

    // Deploy USDC route via CLI
    const usdcSymbol = await usdcChain2.symbol();
    const usdcScale = 1e12; // 6→18 dec
    const usdcWarpId = createWarpRouteConfigId(
      usdcSymbol,
      `${CHAIN_NAME_2}-${CHAIN_NAME_3}`,
    );
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME_2]: {
        type: TokenType.multiCollateral,
        token: usdcChain2.address,
        scale: usdcScale,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.multiCollateral,
        token: usdcChain3.address,
        scale: usdcScale,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    } as WarpRouteDeployConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, usdcWarpId);

    // Deploy USDT route via CLI
    const usdtSymbol = await usdtChain2.symbol();
    const usdtWarpId = createWarpRouteConfigId(
      usdtSymbol,
      `${CHAIN_NAME_2}-${CHAIN_NAME_3}`,
    );
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME_2]: {
        type: TokenType.multiCollateral,
        token: usdtChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.multiCollateral,
        token: usdtChain3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    } as WarpRouteDeployConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, usdtWarpId);

    // Use warp combine to cross-enroll and create merged config
    const mergedWarpRouteId = 'MULTI/test-mc';
    await hyperlaneWarpCombine({
      routes: `${usdcWarpId},${usdtWarpId}`,
      outputWarpRouteId: mergedWarpRouteId,
    });

    // Apply enrollment on-chain for each route
    await hyperlaneWarpApplyRaw({ warpRouteId: usdcWarpId });
    await hyperlaneWarpApplyRaw({ warpRouteId: usdtWarpId });

    // Read deployed configs to get router addresses
    const USDC_WARP_CONFIG_PATH = getCombinedWarpRoutePath(usdcSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    const USDT_WARP_CONFIG_PATH = getCombinedWarpRoutePath(usdtSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    const usdcTokens: ChainMap<Token> = (
      readYamlOrJson(USDC_WARP_CONFIG_PATH) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const usdtTokens: ChainMap<Token> = (
      readYamlOrJson(USDT_WARP_CONFIG_PATH) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const usdcRouter2Addr = usdcTokens[CHAIN_NAME_2].addressOrDenom;
    const usdtRouter3Addr = usdtTokens[CHAIN_NAME_3].addressOrDenom;

    // Collateralize USDT router on chain 3
    const usdtCollateral = parseUnits('10', 18);
    await (await usdtChain3.transfer(usdtRouter3Addr, usdtCollateral)).wait();

    // Read the merged WarpCoreConfig created by warp combine
    const MERGED_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${mergedWarpRouteId}-config.yaml`;

    // Send cross-stablecoin transfer via CLI: USDC(chain2) -> USDT(chain3)
    const sendAmount = parseUnits('1', 6); // 1 USDC in 6-dec
    await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      warpCorePath: MERGED_CONFIG_PATH,
      sourceToken: usdcRouter2Addr,
      destinationToken: usdtRouter3Addr,
      value: sendAmount.toString(),
      skipValidation: true,
    });

    // Verify: 1 USDC(6dec) → canonical 1e18 → 1 USDT(18dec) = 1e18
    const recipientBalance = await usdtChain3.balanceOf(ownerAddress);
    // The balance should include the received 1 USDT (1e18)
    expect(recipientBalance.gte(parseUnits('1', 18))).to.be.true;
  });

  it('should swap same-chain via CLI warp send (USDC -> USDT local)', async function () {
    // Deploy USDC(6dec) and USDT(18dec) on chain 2
    const usdc = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      6,
      'LUSDC2',
      'Local USDC 2',
    );
    const usdt = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      18,
      'LUSDT2',
      'Local USDT 2',
    );

    // Deploy USDC route via CLI (single-chain)
    const usdcSymbol = await usdc.symbol();
    const usdcScale = 1e12; // 6→18 dec
    const usdcWarpId = createWarpRouteConfigId(usdcSymbol, CHAIN_NAME_2);
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME_2]: {
        type: TokenType.multiCollateral,
        token: usdc.address,
        scale: usdcScale,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
    } as WarpRouteDeployConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, usdcWarpId);

    // Deploy USDT route via CLI (single-chain)
    const usdtSymbol = await usdt.symbol();
    const usdtWarpId = createWarpRouteConfigId(usdtSymbol, CHAIN_NAME_2);
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME_2]: {
        type: TokenType.multiCollateral,
        token: usdt.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
    } as WarpRouteDeployConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, usdtWarpId);

    // Combine routes (cross-enroll same-chain routers)
    const mergedWarpRouteId = 'MULTI/test-mc-local';
    await hyperlaneWarpCombine({
      routes: `${usdcWarpId},${usdtWarpId}`,
      outputWarpRouteId: mergedWarpRouteId,
    });

    // Apply enrollment on-chain for each route
    await hyperlaneWarpApplyRaw({ warpRouteId: usdcWarpId });
    await hyperlaneWarpApplyRaw({ warpRouteId: usdtWarpId });

    // Read deployed configs to get router addresses
    const USDC_WARP_CONFIG_PATH = getCombinedWarpRoutePath(usdcSymbol, [
      CHAIN_NAME_2,
    ]);
    const USDT_WARP_CONFIG_PATH = getCombinedWarpRoutePath(usdtSymbol, [
      CHAIN_NAME_2,
    ]);

    const usdcTokens: ChainMap<Token> = (
      readYamlOrJson(USDC_WARP_CONFIG_PATH) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const usdtTokens: ChainMap<Token> = (
      readYamlOrJson(USDT_WARP_CONFIG_PATH) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const usdcRouter2Addr = usdcTokens[CHAIN_NAME_2].addressOrDenom;
    const usdtRouter2Addr = usdtTokens[CHAIN_NAME_2].addressOrDenom;

    // Collateralize USDT router
    const usdtCollateral = parseUnits('10', 18);
    await (await usdt.transfer(usdtRouter2Addr, usdtCollateral)).wait();

    // Read the merged WarpCoreConfig created by warp combine
    const MERGED_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${mergedWarpRouteId}-config.yaml`;

    // Send same-chain swap via CLI: USDC -> USDT on chain 2
    const swapAmount = parseUnits('1', 6); // 1 USDC
    const balanceBefore = await usdt.balanceOf(ownerAddress);

    await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_2,
      warpCorePath: MERGED_CONFIG_PATH,
      sourceToken: usdcRouter2Addr,
      destinationToken: usdtRouter2Addr,
      value: swapAmount.toString(),
      relay: false, // Same-chain: handle() called directly, no relay needed
      skipValidation: true,
    });

    // Verify: 1 USDC(6dec) → canonical 1e18 → 1 USDT(18dec) = 1e18
    const balanceAfter = await usdt.balanceOf(ownerAddress);
    const received = balanceAfter.sub(balanceBefore);
    expect(received.toString()).to.equal(parseUnits('1', 18).toString());
  });
});
