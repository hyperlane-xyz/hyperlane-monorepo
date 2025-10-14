import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';
import { parseEther } from 'ethers/lib/utils.js';

import { ERC20__factory } from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
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
import { Address, ProtocolType, randomInt } from '@hyperlane-xyz/utils';

import { WarpSendLogs } from '../../../send/transfer.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_DEPLOY_DEFAULT_FILE_NAME,
  getWarpCoreConfigPath,
} from '../../constants.js';
import { deployToken } from '../commands/helpers.js';

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/warp-route-deployment.yaml`;
  const CHAIN_2_METADATA_PATH = `${REGISTRY_PATH}/chains/${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2}/metadata.yaml`;
  const CHAIN_3_METADATA_PATH = `${REGISTRY_PATH}/chains/${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3}/metadata.yaml`;

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const evmChain3Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    WARP_DEPLOY_OUTPUT_PATH,
  );

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let walletChain3: Wallet;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain3Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    const providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    const providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);

    walletChain2 = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).connect(
      providerChain2,
    );
    walletChain3 = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).connect(
      providerChain3,
    );
    ownerAddress = walletChain2.address;
  });

  it(`should be able to bridge between ${TokenType.collateral} and ${TokenType.synthetic}`, async function () {
    const token = await deployToken(
      HYP_KEY_BY_PROTOCOL.ethereum,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    );
    const tokenSymbol = await token.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getWarpCoreConfigPath(tokenSymbol, [
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    ]);

    const warpId = createWarpRouteConfigId(
      tokenSymbol,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    );

    const warpConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: token.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      warpId,
    );

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const synthetic = ERC20__factory.connect(
      config[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].addressOrDenom,
      walletChain3,
    );

    const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
      await Promise.all([
        token.callStatic.balanceOf(walletChain2.address),
        synthetic.callStatic.balanceOf(walletChain3.address),
      ]);

    const { stdout, exitCode } = await evmWarpCommands.sendAndRelay({
      origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });
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
      const token = await deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      );
      const tokenSymbol = await token.symbol();

      const warpId = createWarpRouteConfigId(
        tokenSymbol,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      );
      const WARP_CORE_CONFIG_PATH_2_3 = getWarpCoreConfigPath(tokenSymbol, [
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      ]);

      const protocolFeeBeneficiary = randomAddress();
      // 2 gwei of native token
      const maxProtocolFee = ethers.utils.parseUnits('2', 'gwei').toString();
      // 1 gwei of native token
      const protocolFee = ethers.utils.parseUnits('1', 'gwei').toString();

      const warpConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
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
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
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
      await evmWarpCommands.deploy(
        WARP_DEPLOY_OUTPUT_PATH,
        HYP_KEY_BY_PROTOCOL.ethereum,
        warpId,
      );

      const config: ChainMap<Token> = (
        readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
      ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
      const synthetic = ERC20__factory.connect(
        config[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .addressOrDenom,
        walletChain3,
      );

      const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
        await Promise.all([
          token.callStatic.balanceOf(walletChain2.address),
          synthetic.callStatic.balanceOf(walletChain3.address),
        ]);

      const { stdout, exitCode } = await evmWarpCommands.sendAndRelay({
        origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
        relay: true,
        value: testAmount,
        privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });
      expect(exitCode).to.equal(0);
      expect(stdout).to.include(WarpSendLogs.SUCCESS);

      const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
        await Promise.all([
          token.callStatic.balanceOf(walletChain2.address),
          synthetic.callStatic.balanceOf(walletChain3.address),
        ]);

      const protocolFeeAmount =
        testAmount < amountThreshold ? parseEther(protocolFee) : 0;
      const expectedAmountOnChain2 = tokenBalanceOnChain2Before
        .sub(testAmount)
        .sub(protocolFeeAmount);
      const expectedAmountOnChain3 = tokenBalanceOnChain3Before.add(testAmount);

      expect(tokenBalanceOnChain2After.eq(expectedAmountOnChain2)).to.be.true;
      expect(tokenBalanceOnChain3After.eq(expectedAmountOnChain3)).to.be.true;
    });
  });

  it(`should be able to bridge between ${TokenType.collateral} and ${TokenType.collateral}`, async function () {
    const [tokenChain2, tokenChain3] = await Promise.all([
      deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      ),
      deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      ),
    ]);
    const tokenSymbolChain2 = await tokenChain2.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getWarpCoreConfigPath(tokenSymbolChain2, [
      WARP_DEPLOY_DEFAULT_FILE_NAME,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.collateral,
        mailbox: chain3Addresses.mailbox,
        token: tokenChain3.address,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});
    const collateral = parseEther('1');
    const tx = await tokenChain3.transfer(
      config[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].addressOrDenom,
      collateral,
    );
    await tx.wait();

    const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
      await Promise.all([
        tokenChain2.callStatic.balanceOf(walletChain2.address),
        tokenChain3.callStatic.balanceOf(walletChain3.address),
      ]);

    const { stdout } = await evmWarpCommands.sendAndRelay({
      origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
      value: Number(collateral),
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });
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
    const WARP_CORE_CONFIG_PATH_2_3 = getWarpCoreConfigPath('ETH', [
      WARP_DEPLOY_DEFAULT_FILE_NAME,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const synthetic = ERC20__factory.connect(
      config[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3].addressOrDenom,
      walletChain3,
    );
    const [nativeBalanceOnChain2Before, syntheticBalanceOnChain3Before] =
      await Promise.all([
        walletChain2.getBalance(),
        synthetic.callStatic.balanceOf(walletChain3.address),
      ]);

    const { stdout, exitCode } = await evmWarpCommands.sendAndRelay({
      origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

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
    const WARP_CORE_CONFIG_PATH_2_3 = getWarpCoreConfigPath('ETH', [
      WARP_DEPLOY_DEFAULT_FILE_NAME,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.native,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const collateral = parseEther('1');
    // Sending eth to the hypnative contract otherwise bridging will fail
    await walletChain3.sendTransaction({
      to: config[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
        .addressOrDenom,
      value: collateral,
    });

    const [nativeBalanceOnChain2Before, nativeBalanceOnChain3Before] =
      await Promise.all([walletChain2.getBalance(), walletChain3.getBalance()]);

    const { stdout, exitCode } = await evmWarpCommands.sendAndRelay({
      origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
      value: Number(collateral),
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

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
    const WARP_CORE_CONFIG_PATH_2_3 = getWarpCoreConfigPath('ETH', [
      WARP_DEPLOY_DEFAULT_FILE_NAME,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.native,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    const [nativeBalanceOnChain1Before, nativeBalanceOnChain2Before] =
      await Promise.all([walletChain2.getBalance(), walletChain3.getBalance()]);

    const { exitCode, stdout } = await evmWarpCommands
      .sendAndRelay({
        origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
        value: Number(parseEther('1')),
        privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      })
      .nothrow();

    expect(exitCode).to.equal(1);
    expect(stdout).to.include(
      `to ${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3} has INSUFFICIENT collateral`,
    );

    const [nativeBalanceOnChain1After, nativeBalanceOnChain2After] =
      await Promise.all([walletChain2.getBalance(), walletChain3.getBalance()]);

    expect(nativeBalanceOnChain1After.eq(nativeBalanceOnChain1Before)).to.be
      .true;
    expect(nativeBalanceOnChain2After.eq(nativeBalanceOnChain2Before)).to.be
      .true;
  });

  it(`should not be able to bridge between ${TokenType.collateral} and ${TokenType.collateral} when the token on the destination chain does not have enough collateral`, async function () {
    const [tokenChain2, tokenChain3] = await Promise.all([
      deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      ),
      deployToken(
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      ),
    ]);
    const tokenSymbolChain2 = await tokenChain2.symbol();

    const WARP_CORE_CONFIG_PATH_2_3 = getWarpCoreConfigPath(tokenSymbolChain2, [
      WARP_DEPLOY_DEFAULT_FILE_NAME,
    ]);

    const warpConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.collateral,
        mailbox: chain3Addresses.mailbox,
        token: tokenChain3.address,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    const [tokenBalanceOnChain2Before, tokenBalanceOnChain3Before] =
      await Promise.all([
        tokenChain2.callStatic.balanceOf(walletChain2.address),
        tokenChain3.callStatic.balanceOf(walletChain3.address),
      ]);

    const { exitCode, stdout } = await evmWarpCommands
      .sendAndRelay({
        origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        warpCorePath: WARP_CORE_CONFIG_PATH_2_3,
        privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      })
      .nothrow();

    expect(exitCode).to.equal(1);
    expect(stdout).to.include(
      `to ${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3} has INSUFFICIENT collateral`,
    );

    const [tokenBalanceOnChain2After, tokenBalanceOnChain3After] =
      await Promise.all([
        tokenChain2.callStatic.balanceOf(walletChain2.address),
        tokenChain3.callStatic.balanceOf(walletChain3.address),
      ]);

    expect(tokenBalanceOnChain2After.eq(tokenBalanceOnChain2Before)).to.be.true;
    expect(tokenBalanceOnChain3After.eq(tokenBalanceOnChain3Before)).to.be.true;
  });
});
