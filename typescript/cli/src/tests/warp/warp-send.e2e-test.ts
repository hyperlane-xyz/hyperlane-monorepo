import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Wallet } from 'ethers';
import { parseEther } from 'ethers/lib/utils.js';

import { ERC20__factory } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  HookType,
  IsmType,
  Token,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, randomInt } from '@hyperlane-xyz/utils';

import { WarpSendLogs } from '../../send/transfer.js';
import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  WARP_DEPLOY_OUTPUT_PATH,
  deployOrUseExistingCore,
  deployToken,
  getCombinedWarpRoutePath,
} from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

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

  it(`should be able to bridge between ${TokenType.collateral} and ${TokenType.synthetic}`, async function () {
    const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    const tokenSymbol = await token.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
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

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const synthetic = ERC20__factory.connect(
      config[CHAIN_NAME_3].addressOrDenom,
      walletChain3,
    );

    const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
      await Promise.all([
        token.callStatic.balanceOf(walletChain2.address),
        synthetic.callStatic.balanceOf(walletChain3.address),
      ]);

    const { stdout, exitCode } = await hyperlaneWarpSendRelay(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
    );
    expect(exitCode).to.equal(0);
    expect(stdout).to.include(WarpSendLogs.SUCCESS);

    const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
      await Promise.all([
        token.callStatic.balanceOf(walletChain2.address),
        synthetic.callStatic.balanceOf(walletChain3.address),
      ]);

    expect(tokenBalanceOnChain2After.lt(tokenBalanceOnChain2Before)).to.be.true;
    expect(tokenBalanceOnChain3After.gt(tokenBalanceOnChain3Before)).to.be.true;
  });

  it(`should be able to bridge between ${TokenType.collateral} and ${TokenType.synthetic} when using a ${IsmType.AMOUNT_ROUTING} and ${HookType.AMOUNT_ROUTING}`, async function () {
    const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    const tokenSymbol = await token.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    const protocolFeeBeneficiary = randomAddress();
    const protocolFee = '100';
    const maxProtocolFee = '10000';

    const amountThreshold = randomInt(1, 1e4);
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: token.address,
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
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const synthetic = ERC20__factory.connect(
      config[CHAIN_NAME_3].addressOrDenom,
      walletChain3,
    );

    const testAmounts = [
      // Should use the upperIsm
      randomInt(1e6, amountThreshold + 1),
      // Should use the lowerIsm
      randomInt(amountThreshold),
    ];

    for (const amount of testAmounts) {
      const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
        await Promise.all([
          token.callStatic.balanceOf(walletChain2.address),
          synthetic.callStatic.balanceOf(walletChain3.address),
        ]);

      const { stdout, exitCode } = await hyperlaneWarpSendRelay(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH_2_3,
        true,
        amount,
      );
      expect(exitCode).to.equal(0);
      expect(stdout).to.include(WarpSendLogs.SUCCESS);

      const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
        await Promise.all([
          token.callStatic.balanceOf(walletChain2.address),
          synthetic.callStatic.balanceOf(walletChain3.address),
        ]);

      if (amount < amountThreshold) {
        // If the amount is less than the threshold, the protocol fee should be applied
        const protocolFeeAmount = parseEther(protocolFee);
        const expectedAmountOnChain2 = tokenBalanceOnChain2Before
          .sub(amount)
          .sub(protocolFeeAmount);
        // Send receives no protocol fee, so the amount should be the same on chain 3
        const expectedAmountOnChain3 = tokenBalanceOnChain3Before.add(amount);

        expect(tokenBalanceOnChain2After).to.equal(expectedAmountOnChain2);
        expect(tokenBalanceOnChain3After).to.equal(expectedAmountOnChain3);
      } else {
        // If the amount is greater than the threshold, the protocol fee should not be applied
        const expectedAmountOnChain2 = tokenBalanceOnChain2Before.sub(amount);
        const expectedAmountOnChain3 = tokenBalanceOnChain3Before.add(amount);

        expect(tokenBalanceOnChain2After).to.equal(expectedAmountOnChain2);
        expect(tokenBalanceOnChain3After).to.equal(expectedAmountOnChain3);
      }
    }
  });

  it(`should be able to bridge between ${TokenType.collateral} and ${TokenType.collateral}`, async function () {
    const [tokenChain2, tokenChain3] = await Promise.all([
      deployToken(ANVIL_KEY, CHAIN_NAME_2),
      deployToken(ANVIL_KEY, CHAIN_NAME_3),
    ]);
    const tokenSymbolChain2 = await tokenChain2.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(
      tokenSymbolChain2,
      [CHAIN_NAME_2, CHAIN_NAME_3],
    );

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        mailbox: chain3Addresses.mailbox,
        token: tokenChain3.address,
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
        tokenChain2.callStatic.balanceOf(walletChain2.address),
        tokenChain3.callStatic.balanceOf(walletChain3.address),
      ]);

    const { stdout } = await hyperlaneWarpSendRelay(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
      undefined,
      Number(collateral),
    );
    expect(stdout).to.include(WarpSendLogs.SUCCESS);

    const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
      await Promise.all([
        tokenChain2.callStatic.balanceOf(walletChain2.address),
        tokenChain3.callStatic.balanceOf(walletChain3.address),
      ]);

    expect(tokenBalanceOnChain2After.lt(tokenBalanceOnChain2Before)).to.be.true;
    expect(tokenBalanceOnChain3After.gt(tokenBalanceOnChain3Before)).to.be.true;
  });

  it(`should be able to bridge between ${TokenType.native} and ${TokenType.synthetic}`, async function () {
    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
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
        walletChain2.getBalance(),
        synthetic.callStatic.balanceOf(walletChain3.address),
      ]);

    const { stdout, exitCode } = await hyperlaneWarpSendRelay(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
    );

    expect(exitCode).to.equal(0);
    expect(stdout).to.include(WarpSendLogs.SUCCESS);

    const [nativeBalanceOnChain2After, syntheticBalanceOnChain3After] =
      await Promise.all([
        walletChain2.getBalance(),
        synthetic.callStatic.balanceOf(walletChain3.address),
      ]);

    expect(nativeBalanceOnChain2After.lt(nativeBalanceOnChain2Before)).to.be
      .true;
    expect(syntheticBalanceOnChain3After.gt(syntheticBalanceOnChain3Before)).to
      .be.true;
  });

  it(`should be able to bridge between ${TokenType.native} and ${TokenType.native}`, async function () {
    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
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
      await Promise.all([walletChain2.getBalance(), walletChain3.getBalance()]);

    const { stdout, exitCode } = await hyperlaneWarpSendRelay(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
      undefined,
      Number(collateral),
    );

    expect(exitCode).to.equal(0);
    expect(stdout).to.include(WarpSendLogs.SUCCESS);

    const [nativeBalanceOnChain2After, nativeBalanceOnChain3After] =
      await Promise.all([walletChain2.getBalance(), walletChain3.getBalance()]);

    expect(nativeBalanceOnChain2After.lt(nativeBalanceOnChain2Before)).to.be
      .true;
    expect(nativeBalanceOnChain3After.gt(nativeBalanceOnChain3Before)).to.be
      .true;
  });

  it(`should not be able to bridge between ${TokenType.native} and ${TokenType.native} when the token on the destination chain does not have enough collateral`, async function () {
    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
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
      await Promise.all([walletChain2.getBalance(), walletChain3.getBalance()]);

    const { exitCode, stdout } = await hyperlaneWarpSendRelay(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
      undefined,
      Number(parseEther('1')),
    ).nothrow();

    expect(exitCode).to.equal(1);
    expect(stdout).to.include(`to ${CHAIN_NAME_3} has INSUFFICIENT collateral`);

    const [nativeBalanceOnChain1After, nativeBalanceOnChain2After] =
      await Promise.all([walletChain2.getBalance(), walletChain3.getBalance()]);

    expect(nativeBalanceOnChain1After.eq(nativeBalanceOnChain1Before)).to.be
      .true;
    expect(nativeBalanceOnChain2After.eq(nativeBalanceOnChain2Before)).to.be
      .true;
  });

  it(`should not be able to bridge between ${TokenType.collateral} and ${TokenType.collateral} when the token on the destination chain does not have enough collateral`, async function () {
    const [tokenChain2, tokenChain3] = await Promise.all([
      deployToken(ANVIL_KEY, CHAIN_NAME_2),
      deployToken(ANVIL_KEY, CHAIN_NAME_3),
    ]);
    const tokenSymbolChain2 = await tokenChain2.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(
      tokenSymbolChain2,
      [CHAIN_NAME_2, CHAIN_NAME_3],
    );

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        mailbox: chain3Addresses.mailbox,
        token: tokenChain3.address,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
      await Promise.all([
        tokenChain2.callStatic.balanceOf(walletChain2.address),
        tokenChain3.callStatic.balanceOf(walletChain3.address),
      ]);

    const { exitCode, stdout } = await hyperlaneWarpSendRelay(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
    ).nothrow();

    expect(exitCode).to.equal(1);
    expect(stdout).to.include(`to ${CHAIN_NAME_3} has INSUFFICIENT collateral`);

    const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
      await Promise.all([
        tokenChain2.callStatic.balanceOf(walletChain2.address),
        tokenChain3.callStatic.balanceOf(walletChain3.address),
      ]);

    expect(tokenBalanceOnChain2After.eq(tokenBalanceOnChain2Before)).to.be.true;
    expect(tokenBalanceOnChain3After.eq(tokenBalanceOnChain3Before)).to.be.true;
  });
});
