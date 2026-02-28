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
  TokenStandard,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployToken, getDomainId } from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  TEMP_PATH,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp multiCollateral CLI e2e tests', async function () {
  this.timeout(300_000);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let walletChain3: Wallet;

  let chain2DomainId: number;
  let chain3DomainId: number;

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

    chain2DomainId = Number(await getDomainId(CHAIN_NAME_2, ANVIL_KEY));
    chain3DomainId = Number(await getDomainId(CHAIN_NAME_3, ANVIL_KEY));
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

    // Read deployed configs
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

    // Enroll cross-stablecoin routers (bidirectional)
    const usdcRouter2 = MultiCollateral__factory.connect(
      usdcRouter2Addr,
      walletChain2,
    );
    const usdtRouter3 = MultiCollateral__factory.connect(
      usdtRouter3Addr,
      walletChain3,
    );

    await (
      await usdcRouter2.enrollRouters(
        [chain3DomainId],
        [addressToBytes32(usdtRouter3Addr)],
      )
    ).wait();
    await (
      await usdtRouter3.enrollRouters(
        [chain2DomainId],
        [addressToBytes32(usdcRouter2Addr)],
      )
    ).wait();

    // Collateralize USDT router on chain 3
    const usdtCollateral = parseUnits('10', 18);
    await (await usdtChain3.transfer(usdtRouter3Addr, usdtCollateral)).wait();

    // Build merged WarpCoreConfig for CLI warp send
    const usdcCoreConfig = readYamlOrJson(
      USDC_WARP_CONFIG_PATH,
    ) as WarpCoreConfig;
    const usdtCoreConfig = readYamlOrJson(
      USDT_WARP_CONFIG_PATH,
    ) as WarpCoreConfig;

    // Find the specific tokens
    const usdcToken2 = usdcCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_2,
    )!;
    const usdtToken3 = usdtCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )!;

    // Create merged config with cross-stablecoin connections
    const mergedConfig: WarpCoreConfig = {
      tokens: [
        {
          ...usdcToken2,
          connections: [
            {
              token: `ethereum|${CHAIN_NAME_3}|${usdtRouter3Addr}`,
            },
          ],
        },
        {
          ...usdtToken3,
          connections: [
            {
              token: `ethereum|${CHAIN_NAME_2}|${usdcRouter2Addr}`,
            },
          ],
        },
      ],
    };

    const MERGED_CONFIG_PATH = `${TEMP_PATH}/multi-collateral-merged-config.yaml`;
    writeYamlOrJson(MERGED_CONFIG_PATH, mergedConfig);

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

    // Deploy MultiCollateral routers programmatically
    const usdcScale = ethers.BigNumber.from(10).pow(12);
    const usdtScale = ethers.BigNumber.from(1);

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

    // Enroll bidirectionally (same domain)
    const usdcRouterBytes32 = addressToBytes32(usdcRouter.address);
    const usdtRouterBytes32 = addressToBytes32(usdtRouter.address);

    await (
      await usdcRouter.enrollRouters([chain2DomainId], [usdtRouterBytes32])
    ).wait();
    await (
      await usdtRouter.enrollRouters([chain2DomainId], [usdcRouterBytes32])
    ).wait();

    // Collateralize USDT router
    const usdtCollateral = parseUnits('10', 18);
    await (await usdt.transfer(usdtRouter.address, usdtCollateral)).wait();

    // Build WarpCoreConfig for CLI
    const mergedConfig: WarpCoreConfig = {
      tokens: [
        {
          chainName: CHAIN_NAME_2,
          standard: TokenStandard.EvmHypMultiCollateral,
          decimals: 6,
          symbol: 'LUSDC2',
          name: 'Local USDC 2',
          addressOrDenom: usdcRouter.address,
          collateralAddressOrDenom: usdc.address,
          connections: [
            {
              token: `ethereum|${CHAIN_NAME_2}|${usdtRouter.address}`,
            },
          ],
        },
        {
          chainName: CHAIN_NAME_2,
          standard: TokenStandard.EvmHypMultiCollateral,
          decimals: 18,
          symbol: 'LUSDT2',
          name: 'Local USDT 2',
          addressOrDenom: usdtRouter.address,
          collateralAddressOrDenom: usdt.address,
          connections: [
            {
              token: `ethereum|${CHAIN_NAME_2}|${usdcRouter.address}`,
            },
          ],
        },
      ],
    };

    const MERGED_CONFIG_PATH = `${TEMP_PATH}/multi-collateral-local-merged.yaml`;
    writeYamlOrJson(MERGED_CONFIG_PATH, mergedConfig);

    // Send same-chain swap via CLI: USDC -> USDT on chain 2
    // CLI defaults recipient to signer (ownerAddress)
    const swapAmount = parseUnits('1', 6); // 1 USDC
    const balanceBefore = await usdt.balanceOf(ownerAddress);

    await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_2,
      warpCorePath: MERGED_CONFIG_PATH,
      sourceToken: usdcRouter.address,
      destinationToken: usdtRouter.address,
      value: swapAmount.toString(),
      relay: false, // No relay needed for same-chain
      skipValidation: true,
    });

    // Verify: 1 USDC(6dec) → canonical 1e18 → 1 USDT(18dec) = 1e18
    const balanceAfter = await usdt.balanceOf(ownerAddress);
    const received = balanceAfter.sub(balanceBefore);
    expect(received.toString()).to.equal(parseUnits('1', 18).toString());
  });
});
