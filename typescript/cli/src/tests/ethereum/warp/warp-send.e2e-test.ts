import { JsonRpcProvider, Wallet, ethers, parseEther } from 'ethers';
import { expect } from 'chai';

import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainMetadata,
  HookType,
  IsmType,
  type Token,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { type Address, randomInt } from '@hyperlane-xyz/utils';

import { WarpSendLogs } from '../../../send/transfer.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployToken } from '../commands/helpers.js';
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
  WARP_DEPLOY_DEFAULT_FILE_NAME,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp send e2e tests', async function () {
  this.timeout(200_000);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let walletChain3: Wallet;
  let providerChain2: JsonRpcProvider;
  let providerChain3: JsonRpcProvider;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);
    ownerAddress = walletChain2.address;
  });

  it(`should be able to bridge between ${TokenType.collateral} and ${TokenType.synthetic}`, async function () {
    const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    const tokenAddress = await token.getAddress();
    const tokenSymbol = await token.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_3,
    ]);

    const warpId = createWarpRouteConfigId(tokenSymbol, CHAIN_NAME_3);

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenAddress,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, warpId);

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const synthetic = ERC20__factory.connect(
      config[CHAIN_NAME_3].addressOrDenom,
      walletChain3,
    );

    const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
      await Promise.all([
        token.balanceOf(walletChain2.address),
        synthetic.balanceOf(walletChain3.address),
      ]);

    const { stdout, exitCode } = await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
    });
    expect(exitCode).to.equal(0);
    expect(stdout).to.include(WarpSendLogs.SUCCESS);

    let [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
      await Promise.all([
        token.balanceOf(walletChain2.address),
        synthetic.balanceOf(walletChain3.address),
      ]);

    expect(tokenBalanceOnChain2After < tokenBalanceOnChain2Before).to.be.true;
    expect(tokenBalanceOnChain3After > tokenBalanceOnChain3Before).to.be.true;

    // Test with chains parameter
    const { stdout: stdoutChains, exitCode: exitCodeChains } =
      await hyperlaneWarpSendRelay({
        warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
        chains: [CHAIN_NAME_3, CHAIN_NAME_2],
      });
    expect(exitCodeChains).to.equal(0);
    expect(stdoutChains).to.include(WarpSendLogs.SUCCESS);

    [tokenBalanceOnChain2After, tokenBalanceOnChain3After] = await Promise.all([
      token.balanceOf(walletChain2.address),
      synthetic.balanceOf(walletChain3.address),
    ]);

    // Test with --round-trip parameter with --chains
    const { stdout: stdoutRoundTrip, exitCode: exitCodeRoundTrip } =
      await hyperlaneWarpSendRelay({
        warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
        chains: [CHAIN_NAME_2, CHAIN_NAME_3],
        roundTrip: true,
      });
    expect(exitCodeRoundTrip).to.equal(0);
    expect(stdoutRoundTrip).to.include(WarpSendLogs.SUCCESS);

    // Test with --round-trip parameter with --origin and --destination
    const {
      stdout: stdoutRoundTripOriginDestination,
      exitCode: exitCodeRoundTripOriginDestination,
    } = await hyperlaneWarpSendRelay({
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      roundTrip: true,
    });
    expect(exitCodeRoundTripOriginDestination).to.equal(0);
    expect(stdoutRoundTripOriginDestination).to.include(WarpSendLogs.SUCCESS);

    expect(tokenBalanceOnChain2After).to.equal(tokenBalanceOnChain2Before);
    expect(tokenBalanceOnChain3After).to.equal(0n);
  });

  const amountThreshold = randomInt(1, 1e4);
  const testAmounts = [
    // Should use the upperIsm
    randomInt(1e6, amountThreshold + 1),
    // Should use the lowerIsm
    randomInt(1e6, amountThreshold),
  ];

  testAmounts.forEach((testAmount) => {
    it(`should be able to bridge between ${TokenType.collateral} and ${
      TokenType.synthetic
    } when using ${
      testAmount > amountThreshold ? 'upper' : 'lower'
    } threshold on ${IsmType.AMOUNT_ROUTING} ISM`, async function () {
      const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
      const tokenAddress = await token.getAddress();
      const tokenSymbol = await token.symbol();

      const warpId = createWarpRouteConfigId(tokenSymbol, CHAIN_NAME_3);
      const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(tokenSymbol, [
        CHAIN_NAME_3,
      ]);

      const protocolFeeBeneficiary = randomAddress();
      // 2 gwei of native token
      const maxProtocolFee = ethers.parseUnits('2', 'gwei').toString();
      // 1 gwei of native token
      const protocolFee = ethers.parseUnits('1', 'gwei').toString();

      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: tokenAddress,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          hook: {
            type: HookType.AMOUNT_ROUTING,
            threshold: amountThreshold,
            lowerHook: {
              type: HookType.AGGREGATION,
              hooks: [
                {
                  type: HookType.MERKLE_TREE,
                },
                {
                  type: HookType.PROTOCOL_FEE,
                  owner: protocolFeeBeneficiary,
                  protocolFee,
                  beneficiary: protocolFeeBeneficiary,
                  maxProtocolFee,
                },
              ],
            },
            upperHook: {
              type: HookType.MERKLE_TREE,
            },
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          interchainSecurityModule: {
            type: IsmType.AMOUNT_ROUTING,
            threshold: amountThreshold,
            lowerIsm: {
              type: IsmType.TRUSTED_RELAYER,
              relayer: ownerAddress,
            },
            upperIsm: {
              type: IsmType.TRUSTED_RELAYER,
              relayer: ownerAddress,
            },
          },
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, warpId);

      const config: ChainMap<Token> = (
        readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
      ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
      const synthetic = ERC20__factory.connect(
        config[CHAIN_NAME_3].addressOrDenom,
        walletChain3,
      );

      const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
        await Promise.all([
          token.balanceOf(walletChain2.address),
          synthetic.balanceOf(walletChain3.address),
        ]);

      const { stdout, exitCode } = await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
        relay: true,
        value: testAmount,
      });
      expect(exitCode).to.equal(0);
      expect(stdout).to.include(WarpSendLogs.SUCCESS);

      const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
        await Promise.all([
          token.balanceOf(walletChain2.address),
          synthetic.balanceOf(walletChain3.address),
        ]);

      const protocolFeeAmount =
        testAmount < amountThreshold ? parseEther(protocolFee) : 0n;
      const expectedAmountOnChain2 =
        tokenBalanceOnChain2Before - BigInt(testAmount) - protocolFeeAmount;
      const expectedAmountOnChain3 =
        tokenBalanceOnChain3Before + BigInt(testAmount);

      expect(tokenBalanceOnChain2After).to.equal(expectedAmountOnChain2);
      expect(tokenBalanceOnChain3After).to.equal(expectedAmountOnChain3);
    });
  });

  it(`should be able to bridge between ${TokenType.collateral} and ${TokenType.collateral}`, async function () {
    const [tokenChain2, tokenChain3] = await Promise.all([
      deployToken(ANVIL_KEY, CHAIN_NAME_2),
      deployToken(ANVIL_KEY, CHAIN_NAME_3),
    ]);
    const [tokenChain2Address, tokenChain3Address] = await Promise.all([
      tokenChain2.getAddress(),
      tokenChain3.getAddress(),
    ]);
    const tokenSymbolChain2 = await tokenChain2.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(
      tokenSymbolChain2,
      [WARP_DEPLOY_DEFAULT_FILE_NAME],
    );

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2Address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        mailbox: chain3Addresses.mailbox,
        token: tokenChain3Address,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const collateral = parseEther('1');
    const tx = await tokenChain3.transfer(
      config[CHAIN_NAME_3].addressOrDenom,
      collateral,
    );
    await tx.wait();

    const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
      await Promise.all([
        tokenChain2.balanceOf(walletChain2.address),
        tokenChain3.balanceOf(walletChain3.address),
      ]);

    const { stdout } = await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
      value: Number(collateral),
    });
    expect(stdout).to.include(WarpSendLogs.SUCCESS);

    const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
      await Promise.all([
        tokenChain2.balanceOf(walletChain2.address),
        tokenChain3.balanceOf(walletChain3.address),
      ]);

    expect(tokenBalanceOnChain2After < tokenBalanceOnChain2Before).to.be.true;
    expect(tokenBalanceOnChain3After > tokenBalanceOnChain3Before).to.be.true;
  });

  it(`should be able to bridge between ${TokenType.native} and ${TokenType.synthetic}`, async function () {
    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath('ETH', [
      WARP_DEPLOY_DEFAULT_FILE_NAME,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const synthetic = ERC20__factory.connect(
      config[CHAIN_NAME_3].addressOrDenom,
      walletChain3,
    );
    const [nativeBalanceOnChain2Before, syntheticBalanceOnChain3Before] =
      await Promise.all([
        providerChain2.getBalance(walletChain2.address),
        synthetic.balanceOf(walletChain3.address),
      ]);

    const { stdout, exitCode } = await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
    });

    expect(exitCode).to.equal(0);
    expect(stdout).to.include(WarpSendLogs.SUCCESS);

    const [nativeBalanceOnChain2After, syntheticBalanceOnChain3After] =
      await Promise.all([
        providerChain2.getBalance(walletChain2.address),
        synthetic.balanceOf(walletChain3.address),
      ]);

    expect(nativeBalanceOnChain2After < nativeBalanceOnChain2Before).to.be.true;
    expect(syntheticBalanceOnChain3After > syntheticBalanceOnChain3Before).to.be
      .true;
  });

  it(`should be able to bridge between ${TokenType.native} and ${TokenType.native}`, async function () {
    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath('ETH', [
      WARP_DEPLOY_DEFAULT_FILE_NAME,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.native,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const collateral = parseEther('1');
    // Sending eth to the hypnative contract otherwise bridging will fail
    await walletChain3.sendTransaction({
      to: config[CHAIN_NAME_3].addressOrDenom,
      value: collateral,
    });

    const [nativeBalanceOnChain2Before, nativeBalanceOnChain3Before] =
      await Promise.all([
        providerChain2.getBalance(walletChain2.address),
        providerChain3.getBalance(walletChain3.address),
      ]);

    const { stdout, exitCode } = await hyperlaneWarpSendRelay({
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
      value: Number(collateral),
    });

    expect(exitCode).to.equal(0);
    expect(stdout).to.include(WarpSendLogs.SUCCESS);

    const [nativeBalanceOnChain2After, nativeBalanceOnChain3After] =
      await Promise.all([
        providerChain2.getBalance(walletChain2.address),
        providerChain3.getBalance(walletChain3.address),
      ]);

    expect(nativeBalanceOnChain2After < nativeBalanceOnChain2Before).to.be.true;
    expect(nativeBalanceOnChain3After > nativeBalanceOnChain3Before).to.be.true;
  });

  it(`should not be able to bridge between ${TokenType.native} and ${TokenType.native} when the token on the destination chain does not have enough collateral`, async function () {
    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath('ETH', [
      WARP_DEPLOY_DEFAULT_FILE_NAME,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.native,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const [nativeBalanceOnChain1Before, nativeBalanceOnChain2Before] =
      await Promise.all([
        providerChain2.getBalance(walletChain2.address),
        providerChain3.getBalance(walletChain3.address),
      ]);

    const { exitCode, stdout } = await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
      value: Number(parseEther('1')),
    }).nothrow();

    expect(exitCode).to.equal(1);
    expect(stdout).to.include(`to ${CHAIN_NAME_3} has INSUFFICIENT collateral`);

    const [nativeBalanceOnChain1After, nativeBalanceOnChain2After] =
      await Promise.all([
        providerChain2.getBalance(walletChain2.address),
        providerChain3.getBalance(walletChain3.address),
      ]);

    expect(nativeBalanceOnChain1After).to.equal(nativeBalanceOnChain1Before);
    expect(nativeBalanceOnChain2After).to.equal(nativeBalanceOnChain2Before);
  });

  it(`should not be able to bridge between ${TokenType.collateral} and ${TokenType.collateral} when the token on the destination chain does not have enough collateral`, async function () {
    const [tokenChain2, tokenChain3] = await Promise.all([
      deployToken(ANVIL_KEY, CHAIN_NAME_2),
      deployToken(ANVIL_KEY, CHAIN_NAME_3),
    ]);
    const [tokenChain2Address, tokenChain3Address] = await Promise.all([
      tokenChain2.getAddress(),
      tokenChain3.getAddress(),
    ]);
    const tokenSymbolChain2 = await tokenChain2.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(
      tokenSymbolChain2,
      [WARP_DEPLOY_DEFAULT_FILE_NAME],
    );

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2Address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        mailbox: chain3Addresses.mailbox,
        token: tokenChain3Address,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
      await Promise.all([
        tokenChain2.balanceOf(walletChain2.address),
        tokenChain3.balanceOf(walletChain3.address),
      ]);

    const { exitCode, stdout } = await hyperlaneWarpSendRelay({
      origin: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
    }).nothrow();

    expect(exitCode).to.equal(1);
    expect(stdout).to.include(`to ${CHAIN_NAME_3} has INSUFFICIENT collateral`);

    const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
      await Promise.all([
        tokenChain2.balanceOf(walletChain2.address),
        tokenChain3.balanceOf(walletChain3.address),
      ]);

    expect(tokenBalanceOnChain2After).to.equal(tokenBalanceOnChain2Before);
    expect(tokenBalanceOnChain3After).to.equal(tokenBalanceOnChain3Before);
  });
});
