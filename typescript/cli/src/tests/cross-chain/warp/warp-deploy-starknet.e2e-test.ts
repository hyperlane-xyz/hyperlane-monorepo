import { expect } from 'chai';
import { Wallet } from 'ethers';
import { type StartedTestContainer } from 'testcontainers';

import { TEST_STARKNET_ACCOUNT_ADDRESS } from '@hyperlane-xyz/starknet-sdk/testing';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type DerivedWarpRouteDeployConfig,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CROSS_CHAIN_E2E_TEST_TIMEOUT,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { runEvmNode, runStarknetNode } from '../../nodes.js';
import { assertWarpRouteConfig } from '../../utils.js';
import { expectStarknetWarpConfig } from '../../starknet/helpers.js';

describe('hyperlane warp deploy e2e tests (Starknet x EVM)', async function () {
  this.timeout(2 * CROSS_CHAIN_E2E_TEST_TIMEOUT);

  const starknetTokenData =
    TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1.nativeToken;
  assert(starknetTokenData?.denom, 'Expected Starknet native token denom');

  let starknetCoreAddress: ChainAddresses;
  const starknetCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  );

  let evmCoreAddress: ChainAddresses;
  const evmCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const WARP_CORE_PATH = getWarpCoreConfigPath(starknetTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(starknetTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(starknetTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Starknet,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  let coreAddressByChain: ChainMap<ChainAddresses>;
  let starknetNode: StartedTestContainer;
  let evmNode: StartedTestContainer;
  let previousAccountAddress: string | undefined;

  before(async function () {
    previousAccountAddress = process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
    process.env.HYP_ACCOUNT_ADDRESS_STARKNET = TEST_STARKNET_ACCOUNT_ADDRESS;

    [starknetNode, evmNode] = await Promise.all([
      runStarknetNode(TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1),
      runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2),
    ]);

    [starknetCoreAddress, evmCoreAddress] = await Promise.all([
      starknetCore.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
      evmCore.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    coreAddressByChain = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: starknetCoreAddress,
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: evmCoreAddress,
    };
  });

  after(async () => {
    await Promise.all([starknetNode?.stop(), evmNode?.stop()].filter(Boolean));
    if (previousAccountAddress === undefined) {
      delete process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
    } else {
      process.env.HYP_ACCOUNT_ADDRESS_STARKNET = previousAccountAddress;
    }
  });

  let warpDeployConfig: WarpRouteDeployConfig;
  beforeEach(() => {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: {
        type: TokenType.native,
        mailbox: starknetCoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: evmCoreAddress.mailbox,
        owner: new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
        name: starknetTokenData.name,
        symbol: starknetTokenData.symbol,
        decimals: starknetTokenData.decimals,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
  });

  it('should successfully deploy on Starknet and EVM', async () => {
    const output = await hyperlaneWarp
      .deployRaw({
        warpRouteId: WARP_ROUTE_ID,
        skipConfirmationPrompts: true,
        extraArgs: [
          `--key.${ProtocolType.Starknet}`,
          HYP_KEY_BY_PROTOCOL.starknet,
          `--key.${ProtocolType.Ethereum}`,
          HYP_KEY_BY_PROTOCOL.ethereum,
        ],
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(0);

    await hyperlaneWarp.readRaw({
      warpRouteId: WARP_ROUTE_ID,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const config: DerivedWarpRouteDeployConfig = readYamlOrJson(
      WARP_READ_OUTPUT_PATH,
    );

    expectStarknetWarpConfig(
      warpDeployConfig,
      config,
      coreAddressByChain,
      TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    );
    assertWarpRouteConfig(
      warpDeployConfig,
      config,
      coreAddressByChain,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    );
  });
});
