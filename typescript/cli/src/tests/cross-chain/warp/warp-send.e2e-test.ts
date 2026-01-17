import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';
import fs from 'fs';
import { type StartedTestContainer } from 'testcontainers';

import {
  createSignerWithPrivateKey,
  runCosmosNode,
} from '@hyperlane-xyz/cosmos-sdk/testing';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenType, type WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL,
  CROSS_CHAIN_E2E_TEST_TIMEOUT,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  TEST_TOKEN_SYMBOL,
  UNSUPPORTED_CHAIN_CORE_ADDRESSES,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { runEvmNode } from '../../nodes.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

describe('hyperlane warp send cross-chain e2e tests', async function () {
  this.timeout(CROSS_CHAIN_E2E_TEST_TIMEOUT);

  let cosmosNativeDeployerAddress: Address;
  let cosmosNativeChain1CoreAddress: ChainAddresses;
  const cosmosNativeChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    REGISTRY_PATH,
    CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL.cosmosnative,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
  );

  let evmDeployerAddress: Address;
  let evmChain1CoreAddress: ChainAddresses;
  const evmChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  let radixChain1CoreAddress: ChainAddresses;
  const radixChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Radix,
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
    REGISTRY_PATH,
    CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL.radix,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
  );

  const warpChains = [
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
  ];
  const WARP_CORE_PATH = getWarpCoreConfigPath(TEST_TOKEN_SYMBOL, warpChains);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(
    TEST_TOKEN_SYMBOL,
    warpChains,
  );
  const WARP_ROUTE_ID = getWarpId(TEST_TOKEN_SYMBOL, warpChains);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.CosmosNative,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  let cosmosNodeInstance: StartedTestContainer;
  let evmNodeInstance: StartedTestContainer;

  let previousSkipWarpCleanup: string | undefined;

  before(async function () {
    cosmosNodeInstance = await runCosmosNode(
      TEST_CHAIN_METADATA_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    );
    evmNodeInstance = await runEvmNode(
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    );

    const cosmosWallet = await createSignerWithPrivateKey(
      HYP_KEY_BY_PROTOCOL.cosmosnative,
      TEST_CHAIN_METADATA_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    );
    cosmosNativeDeployerAddress = cosmosWallet.getSignerAddress();

    evmDeployerAddress = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address;

    [
      cosmosNativeChain1CoreAddress,
      evmChain1CoreAddress,
      radixChain1CoreAddress,
    ] = await Promise.all([
      cosmosNativeChain1Core.deployOrUseExistingCore(
        HYP_KEY_BY_PROTOCOL.cosmosnative,
      ),
      evmChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      radixChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.radix),
    ]);

    writeYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN,
      UNSUPPORTED_CHAIN_CORE_ADDRESSES,
    );

    previousSkipWarpCleanup = process.env.HYP_CROSSCHAIN_SKIP_WARP_CLEANUP;
    process.env.HYP_CROSSCHAIN_SKIP_WARP_CLEANUP = 'true';

    const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;
    if (fs.existsSync(deploymentPaths)) {
      fs.rmSync(deploymentPaths, { recursive: true, force: true });
    }

    const warpDeployConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1]: {
        type: TokenType.collateral,
        token: 'uhyp',
        mailbox: cosmosNativeChain1CoreAddress.mailbox,
        owner: cosmosNativeDeployerAddress,
        name: TEST_TOKEN_SYMBOL,
        symbol: TEST_TOKEN_SYMBOL,
        decimals: 6,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: evmChain1CoreAddress.mailbox,
        owner: evmDeployerAddress,
        name: TEST_TOKEN_SYMBOL,
        symbol: TEST_TOKEN_SYMBOL,
        decimals: 6,
        // Seed a minimal balance so EVM-origin sends can run without cross-VM delivery.
        initialSupply: 10,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]: {
        type: TokenType.synthetic,
        mailbox: radixChain1CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
        name: TEST_TOKEN_SYMBOL,
        symbol: TEST_TOKEN_SYMBOL,
        decimals: 6,
        // Seed a minimal balance so Radix-origin sends can run without cross-VM delivery.
        initialSupply: 10,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    const deployOutput = await hyperlaneWarp
      .deployRaw({
        warpRouteId: WARP_ROUTE_ID,
        warpDeployPath: WARP_DEPLOY_PATH,
        skipConfirmationPrompts: true,
        extraArgs: [
          `--key.${ProtocolType.Ethereum}`,
          HYP_KEY_BY_PROTOCOL.ethereum,
          `--key.${ProtocolType.CosmosNative}`,
          HYP_KEY_BY_PROTOCOL.cosmosnative,
          `--key.${ProtocolType.Radix}`,
          HYP_KEY_BY_PROTOCOL.radix,
        ],
      })
      .stdio('pipe')
      .nothrow();

    expect(deployOutput.exitCode).to.eql(0);
  });

  after(async () => {
    if (previousSkipWarpCleanup === undefined) {
      delete process.env.HYP_CROSSCHAIN_SKIP_WARP_CLEANUP;
    } else {
      process.env.HYP_CROSSCHAIN_SKIP_WARP_CLEANUP = previousSkipWarpCleanup;
    }

    const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;
    if (fs.existsSync(deploymentPaths)) {
      fs.rmSync(deploymentPaths, { recursive: true, force: true });
    }

    await Promise.all([cosmosNodeInstance?.stop(), evmNodeInstance?.stop()]);
  });

  const sendKeys = [
    `--key.${ProtocolType.Ethereum}`,
    HYP_KEY_BY_PROTOCOL.ethereum,
    `--key.${ProtocolType.CosmosNative}`,
    HYP_KEY_BY_PROTOCOL.cosmosnative,
    `--key.${ProtocolType.Radix}`,
    HYP_KEY_BY_PROTOCOL.radix,
  ];

  // Generate all origin -> destination pairs (excluding same-chain sends)
  const sendCases = warpChains
    .flatMap((origin) =>
      warpChains
        .filter((dest) => dest !== origin)
        .map((destination) => ({
          origin,
          destination,
          // CosmosNative origins skip transfer validation
          expectSkipValidationLog:
            origin === TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
        })),
    )
    .sort(
      (a, b) =>
        a.origin.localeCompare(b.origin) ||
        a.destination.localeCompare(b.destination),
    );

  const sendAndAssert = async (testCase: (typeof sendCases)[number]) => {
    const output = await hyperlaneWarp
      .sendRaw({
        origin: testCase.origin,
        destination: testCase.destination,
        warpRouteId: WARP_ROUTE_ID,
        amount: 1,
        quick: true,
        extraArgs: sendKeys,
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.eql(0);
    const outputText = output.text();
    expect(outputText).to.include('Message ID:');
    expect(outputText).to.include('Explorer Link:');
    if (testCase.expectSkipValidationLog) {
      expect(outputText).to.include(
        `Skipping transfer validation for ${testCase.origin}`,
      );
    }
  };

  // NOTE: These tests validate that cross-VM send transactions succeed and
  // produce message IDs. They intentionally skip delivery checks because the
  // CLI relayer is EVM-only and cannot deliver messages that originate from or
  // target non-EVM chains. To test relaying/delivery:
  // - run the Rust relayer (binary `relayer`) with a multi-chain agent config
  //   and keys for CosmosNative + Radix + EVM (see rust/main/utils/run-locally),
  //   or wait for the CLI relayer to add non-EVM support.
  // - remove `quick: true` so the send path waits for delivery.
  for (const testCase of sendCases) {
    it(`should send ${testCase.origin} -> ${testCase.destination}`, async function () {
      await sendAndAssert(testCase);
    });
  }
});
