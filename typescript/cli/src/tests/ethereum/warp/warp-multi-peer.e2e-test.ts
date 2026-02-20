import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';
import { parseUnits } from 'ethers/lib/utils.js';

import { MultiCollateral__factory } from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainMetadata,
  type Token,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  deployToken,
  getDomainId,
  hyperlaneStatus,
} from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  sendWarpRouteMessageRoundTrip,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp multiCollateral e2e tests', async function () {
  this.timeout(200_000);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let walletChain3: Wallet;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    const providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    const providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);
    ownerAddress = walletChain2.address;
  });

  it('should bridge same-stablecoin round trip (multiCollateral <-> multiCollateral)', async function () {
    // Deploy same token on both chains
    const tokenChain2 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      6,
      'USDC',
      'USD Coin',
    );
    const tokenChain3 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_3,
      6,
      'USDC',
      'USD Coin',
    );
    const tokenSymbol = await tokenChain2.symbol();

    const WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    const warpId = createWarpRouteConfigId(
      tokenSymbol,
      `${CHAIN_NAME_2}-${CHAIN_NAME_3}`,
    );

    // Deploy config: multiCollateral on both chains
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.multiCollateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.multiCollateral,
        token: tokenChain3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, warpId);

    // Read deployed config to get router addresses
    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    // Collateralize both routers
    const decimals = await tokenChain2.decimals();
    const collateralAmount = parseUnits('2', decimals);

    await (
      await tokenChain2.transfer(
        config[CHAIN_NAME_2].addressOrDenom,
        collateralAmount,
      )
    ).wait();
    await (
      await tokenChain3.transfer(
        config[CHAIN_NAME_3].addressOrDenom,
        collateralAmount,
      )
    ).wait();

    // Send round trip via standard transferRemote (same stablecoin = enrolled routers)
    await sendWarpRouteMessageRoundTrip(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH,
    );
  });

  it('should bridge cross-stablecoin via transferRemoteTo (USDC -> USDT)', async function () {
    // Deploy USDC(6dec) on both chains and USDT(18dec) on both chains
    // Deploy sequentially per chain to avoid nonce collisions
    const usdcChain2 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      6,
      'MUSDC',
      'Mock USDC',
    );
    const usdtChain2 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      18,
      'MUSDT',
      'Mock USDT',
    );
    const usdcChain3 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_3,
      6,
      'MUSDC',
      'Mock USDC',
    );
    const usdtChain3 = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_3,
      18,
      'MUSDT',
      'Mock USDT',
    );

    // Deploy USDC warp route (multiCollateral <-> multiCollateral)
    const usdcSymbol = await usdcChain2.symbol();
    const USDC_WARP_CONFIG_PATH = getCombinedWarpRoutePath(usdcSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    const usdcWarpId = createWarpRouteConfigId(
      usdcSymbol,
      `${CHAIN_NAME_2}-${CHAIN_NAME_3}`,
    );

    // USDC = 6 decimals, scale = 1e12 to normalize to 18-dec canonical
    const usdcScale = 1e12;
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
    });
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, usdcWarpId);

    // Deploy USDT warp route (multiCollateral <-> multiCollateral)
    const usdtSymbol = await usdtChain2.symbol();
    const USDT_WARP_CONFIG_PATH = getCombinedWarpRoutePath(usdtSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    const usdtWarpId = createWarpRouteConfigId(
      usdtSymbol,
      `${CHAIN_NAME_2}-${CHAIN_NAME_3}`,
    );

    // USDT = 18 decimals, scale = 1 (default, canonical = local)
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
    });
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, usdtWarpId);

    // Read deployed configs to get router addresses
    const usdcTokens: ChainMap<Token> = (
      readYamlOrJson(USDC_WARP_CONFIG_PATH) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const usdtTokens: ChainMap<Token> = (
      readYamlOrJson(USDT_WARP_CONFIG_PATH) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const usdcRouter2Addr = usdcTokens[CHAIN_NAME_2].addressOrDenom;
    const usdtRouter3Addr = usdtTokens[CHAIN_NAME_3].addressOrDenom;

    // Connect to routers
    const usdcRouter2 = MultiCollateral__factory.connect(
      usdcRouter2Addr,
      walletChain2,
    );
    const usdtRouter3 = MultiCollateral__factory.connect(
      usdtRouter3Addr,
      walletChain3,
    );

    // Get domain IDs
    const chain3DomainId = Number(await getDomainId(CHAIN_NAME_3, ANVIL_KEY));
    const chain2DomainId = Number(await getDomainId(CHAIN_NAME_2, ANVIL_KEY));

    // Enroll cross-stablecoin routers (bidirectional)
    const usdcRouter2Bytes32 = addressToBytes32(usdcRouter2Addr);
    const usdtRouter3Bytes32 = addressToBytes32(usdtRouter3Addr);

    await (
      await usdcRouter2.enrollRouters([chain3DomainId], [usdtRouter3Bytes32])
    ).wait();
    await (
      await usdtRouter3.enrollRouters([chain2DomainId], [usdcRouter2Bytes32])
    ).wait();

    // Collateralize USDT router on chain 3
    const usdtCollateral = parseUnits('10', 18);
    await (await usdtChain3.transfer(usdtRouter3Addr, usdtCollateral)).wait();

    // Approve USDC for usdcRouter2
    const sendAmount = parseUnits('1', 6); // 1 USDC
    await (await usdcChain2.approve(usdcRouter2Addr, sendAmount)).wait();

    // Send cross-stablecoin transfer via transferRemoteTo
    const recipientAddr = '0x0000000000000000000000000000000000000042';
    const recipientBytes32 = addressToBytes32(recipientAddr);

    // Quote gas payment for protocol fee
    const gasPayment = await usdcRouter2.quoteGasPayment(chain3DomainId);

    const tx = await usdcRouter2.transferRemoteTo(
      chain3DomainId,
      recipientBytes32,
      sendAmount,
      usdtRouter3Bytes32,
      { value: gasPayment },
    );
    const receipt = await tx.wait();

    // Relay the message
    await hyperlaneStatus({
      origin: CHAIN_NAME_2,
      dispatchTx: receipt.transactionHash,
      relay: true,
      key: ANVIL_KEY,
    });

    // Verify: 1 USDC(6dec) → canonical 1e18 → 1 USDT(18dec) = 1e18
    const recipientBalance = await usdtChain3.balanceOf(recipientAddr);
    expect(recipientBalance.toString()).to.equal(
      parseUnits('1', 18).toString(),
    );
  });

  it('should swap same-chain via localTransferTo (USDC -> USDT)', async function () {
    // Deploy USDC(6dec) and USDT(18dec) on chain 2
    const usdc = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      6,
      'LUSDC',
      'Local USDC',
    );
    const usdt = await deployToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      18,
      'LUSDT',
      'Local USDT',
    );

    // Deploy MultiCollateral routers programmatically
    const usdcScale = ethers.BigNumber.from(10).pow(12); // 6→18 dec scaling
    const usdtScale = ethers.BigNumber.from(1); // 18→18 dec (no scaling)

    const usdcRouter = await new MultiCollateral__factory(walletChain2).deploy(
      usdc.address,
      usdcScale,
      chain2Addresses.mailbox,
    );
    await usdcRouter.deployed();
    await (
      await usdcRouter.initialize(
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        ownerAddress,
      )
    ).wait();

    const usdtRouter = await new MultiCollateral__factory(walletChain2).deploy(
      usdt.address,
      usdtScale,
      chain2Addresses.mailbox,
    );
    await usdtRouter.deployed();
    await (
      await usdtRouter.initialize(
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        ownerAddress,
      )
    ).wait();

    // Get local domain ID for router enrollment
    const localDomainId = Number(await getDomainId(CHAIN_NAME_2, ANVIL_KEY));

    // Enroll as local routers (bidirectional)
    const usdcRouterBytes32 = addressToBytes32(usdcRouter.address);
    const usdtRouterBytes32 = addressToBytes32(usdtRouter.address);

    await (
      await usdcRouter.enrollRouters([localDomainId], [usdtRouterBytes32])
    ).wait();
    await (
      await usdtRouter.enrollRouters([localDomainId], [usdcRouterBytes32])
    ).wait();

    // Collateralize USDT router
    const usdtCollateral = parseUnits('10', 18);
    await (await usdt.transfer(usdtRouter.address, usdtCollateral)).wait();

    // Approve USDC for usdcRouter
    const swapAmount = parseUnits('1', 6); // 1 USDC
    await (await usdc.approve(usdcRouter.address, swapAmount)).wait();

    // Execute same-chain swap
    const recipientAddr = '0x0000000000000000000000000000000000000043';
    const balanceBefore = await usdt.balanceOf(recipientAddr);

    await (
      await usdcRouter.localTransferTo(
        usdtRouter.address,
        recipientAddr,
        swapAmount,
      )
    ).wait();

    // Verify: 1 USDC(6dec) → canonical 1e18 → 1 USDT(18dec) = 1e18
    const balanceAfter = await usdt.balanceOf(recipientAddr);
    const received = balanceAfter.sub(balanceBefore);
    expect(received.toString()).to.equal(parseUnits('1', 18).toString());
  });
});
