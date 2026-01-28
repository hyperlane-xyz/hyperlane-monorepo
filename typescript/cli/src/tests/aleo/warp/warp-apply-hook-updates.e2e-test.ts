import { type ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenType } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../../utils/files.js';
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
import { createHookUpdateTests } from '../../helpers/warp-hook-test-factory.js';

describe('hyperlane warp apply Hook updates (Aleo E2E tests)', async function () {
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

  before(async function () {
    await hyperlaneCore1.deploy(HYP_KEY_BY_PROTOCOL.aleo);

    chain1CoreAddress = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1}/addresses.yaml`,
    );
  });

  beforeEach(() => {
    // Generate unique short suffix for each test to avoid program name collisions
    const uniqueSuffix = Math.random().toString(36).substring(2, 8);
    process.env.ALEO_WARP_SUFFIX = uniqueSuffix;
  });

  createHookUpdateTests(
    {
      protocol: ProtocolType.Aleo,
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1,
      get baseWarpConfig() {
        return {
          [TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1]: {
            type: TokenType.native,
            mailbox: chain1CoreAddress.mailbox,
            owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
            name: nativeTokenData.name,
            symbol: nativeTokenData.symbol,
            decimals: nativeTokenData.decimals,
          },
        };
      },
      privateKey: HYP_KEY_BY_PROTOCOL.aleo,
      warpRoutePath: WARP_CORE_PATH,
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ROUTE_ID,
      warpReadOutputPath: WARP_READ_OUTPUT_PATH,
    },
    hyperlaneWarp,
  );
});
