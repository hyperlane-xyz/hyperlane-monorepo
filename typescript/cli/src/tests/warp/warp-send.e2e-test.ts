import { JsonRpcProvider } from '@ethersproject/providers';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';
import { parseEther } from 'ethers/lib/utils.js';

import { ERC20__factory } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  Token,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

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
  REGISTRY_PATH,
  TEMP_PATH,
  deployOrUseExistingCore,
  deployToken,
  sendWarpRouteMessageRoundTrip,
} from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

const WARP_CONFIG_PATH = `${TEMP_PATH}/warp-route-deployment-deploy.yaml`;

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

    const WARP_CORE_CONFIG_PATH_2_3 = `${REGISTRY_PATH}/deployments/warp_routes/${tokenSymbol}/anvil2-anvil3-config.yaml`;

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

    writeYamlOrJson(WARP_CONFIG_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

    // Try to send a transaction
    const { stdout } = await sendWarpRouteMessageRoundTrip(
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      WARP_CORE_CONFIG_PATH_2_3,
    );
    expect(stdout).to.include(WarpSendLogs.SUCCESS);
  });

  it(`should be able to bridge between ${TokenType.native} and ${TokenType.synthetic}`, async function () {
    const WARP_CORE_CONFIG_PATH_2_3 = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-anvil3-config.yaml`;

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

    writeYamlOrJson(WARP_CONFIG_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const synthetic = ERC20__factory.connect(
      config[CHAIN_NAME_3].addressOrDenom,
      walletChain3,
    );
    const [nativeBalanceOnChain1Before, syntheticBalanceOnChain2Before] =
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

    const [nativeBalanceOnChain1After, syntheticBalanceOnChain2After] =
      await Promise.all([
        walletChain2.getBalance(),
        synthetic.callStatic.balanceOf(walletChain3.address),
      ]);

    expect(nativeBalanceOnChain1After.lt(nativeBalanceOnChain1Before)).to.be
      .true;
    expect(syntheticBalanceOnChain2After.gt(syntheticBalanceOnChain2Before)).to
      .be.true;
  });

  it.only(`should be able to bridge between ${TokenType.native} and ${TokenType.native}`, async function () {
    const WARP_CORE_CONFIG_PATH_2_3 = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil2-anvil3-config.yaml`;

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: chain2Addresses.mailbox,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.native,
        mailbox: chain3Addresses.mailbox,
        owner: chain3Addresses.mailbox,
      },
    };

    writeYamlOrJson(WARP_CONFIG_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

    const config: ChainMap<Token> = (
      readYamlOrJson(WARP_CORE_CONFIG_PATH_2_3) as WarpCoreConfig
    ).tokens.reduce((acc, curr) => ({ ...acc, [curr.chainName]: curr }), {});

    const collateral = parseEther('1');
    await walletChain3.sendTransaction({
      to: config[CHAIN_NAME_3].addressOrDenom,
      value: collateral,
    });

    const [nativeBalanceOnChain1Before, nativeBalanceOnChain2Before] =
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

    const [nativeBalanceOnChain1After, nativeBalanceOnChain2After] =
      await Promise.all([walletChain2.getBalance(), walletChain3.getBalance()]);

    expect(nativeBalanceOnChain1After.lt(nativeBalanceOnChain1Before)).to.be
      .true;
    expect(nativeBalanceOnChain2After.gt(nativeBalanceOnChain2Before)).to.be
      .true;
  });
});
