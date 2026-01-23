import { expect } from 'chai';

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
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  TEST_TOKEN_SYMBOL,
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { assertWarpRouteConfig } from '../../utils.js';

describe('hyperlane warp deploy (Aleo E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const nativeTokenData =
    TEST_CHAIN_METADATA_BY_PROTOCOL.aleo.CHAIN_NAME_1.nativeToken;
  assert(
    nativeTokenData,
    `Expected native token data to be defined for chain ${TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1}`,
  );

  let chain1CoreAddress: ChainAddresses;
  const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Aleo,
    TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_1,
  );

  let chain2CoreAddress: ChainAddresses;
  const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Aleo,
    TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.aleo,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.aleo.CHAIN_NAME_2,
  );

  const WARP_CORE_PATH = getWarpCoreConfigPath(TEST_TOKEN_SYMBOL, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(TEST_TOKEN_SYMBOL, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(TEST_TOKEN_SYMBOL, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Aleo,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  let coreAddressByChain: ChainMap<ChainAddresses>;

  before(async function () {
    // Deploy core contracts on both chains in parallel
    await Promise.all([
      hyperlaneCore1.deploy(HYP_KEY_BY_PROTOCOL.aleo),
      hyperlaneCore2.deploy(HYP_KEY_BY_PROTOCOL.aleo),
    ]);

    chain1CoreAddress = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1}/addresses.yaml`,
    );
    chain2CoreAddress = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_2}/addresses.yaml`,
    );

    coreAddressByChain = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1]: chain1CoreAddress,
      [TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_2]: chain2CoreAddress,
    };
  });

  let warpDeployConfig: WarpRouteDeployConfig;
  beforeEach(() => {
    // Generate unique short suffix for each test to avoid program name collisions
    const uniqueSuffix = Math.random().toString(36).substring(2, 8);
    process.env.ALEO_WARP_SUFFIX = uniqueSuffix;

    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1]: {
        type: TokenType.native,
        mailbox: chain1CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: chain2CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
        name: nativeTokenData.name,
        symbol: nativeTokenData.symbol,
        decimals: nativeTokenData.decimals,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
  });

  it('should successfully deploy on multiple chains', async () => {
    const output = await hyperlaneWarp
      .deployRaw({
        warpRouteId: WARP_ROUTE_ID,
        skipConfirmationPrompts: true,
        privateKey: HYP_KEY_BY_PROTOCOL.aleo,
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.eql(0);

    await hyperlaneWarp.readRaw({
      warpRouteId: WARP_ROUTE_ID,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const config: DerivedWarpRouteDeployConfig = readYamlOrJson(
      WARP_READ_OUTPUT_PATH,
    );

    for (const chainName of Object.keys(warpDeployConfig)) {
      assertWarpRouteConfig(
        warpDeployConfig,
        config,
        coreAddressByChain,
        chainName,
      );
    }
  });

  it('should deploy and set the owner to the expected one in the config', async () => {
    const differentOwner =
      'aleo17m3l8a4hmf3wypzkf5lsausfdwq9etzyujd0vmqh35ledn2sgvqqzqkqal';
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1].owner =
      differentOwner;
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    const output = await hyperlaneWarp
      .deployRaw({
        warpRouteId: WARP_ROUTE_ID,
        skipConfirmationPrompts: true,
        privateKey: HYP_KEY_BY_PROTOCOL.aleo,
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.eql(0);

    await hyperlaneWarp.readRaw({
      warpRouteId: WARP_ROUTE_ID,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const config: DerivedWarpRouteDeployConfig = readYamlOrJson(
      WARP_READ_OUTPUT_PATH,
    );

    for (const chainName of Object.keys(warpDeployConfig)) {
      assertWarpRouteConfig(
        warpDeployConfig,
        config,
        coreAddressByChain,
        chainName,
      );
    }
  });
});
