import { type ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenType } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
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
import { createIsmUpdateTests } from '../../helpers/warp-ism-test-factory.js';

describe('hyperlane warp apply ISM updates (Radix E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const nativeTokenData =
    TEST_CHAIN_METADATA_BY_PROTOCOL.radix.CHAIN_NAME_1.nativeToken;
  assert(
    nativeTokenData,
    `Expected native token data to be defined for chain ${TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1}`,
  );
  const nativeTokenAddress = nativeTokenData.denom;
  assert(
    nativeTokenAddress,
    `Expected native token address to be defined for ${TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1}`,
  );

  let chain1CoreAddress: ChainAddresses;
  const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Radix,
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.radix,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_1,
  );

  const WARP_CORE_PATH = getWarpCoreConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Radix,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  before(async function () {
    chain1CoreAddress = await hyperlaneCore1.deployOrUseExistingCore(
      HYP_KEY_BY_PROTOCOL.radix,
    );
  });

  createIsmUpdateTests(
    {
      protocol: ProtocolType.Radix,
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1,
      get baseWarpConfig() {
        return {
          [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]: {
            type: TokenType.collateral,
            token: nativeTokenAddress,
            mailbox: chain1CoreAddress.mailbox,
            owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
            name: nativeTokenData.name,
            symbol: nativeTokenData.symbol,
            decimals: nativeTokenData.decimals,
          },
        };
      },
      privateKey: HYP_KEY_BY_PROTOCOL.radix,
      warpRoutePath: WARP_CORE_PATH,
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ROUTE_ID,
      warpReadOutputPath: WARP_READ_OUTPUT_PATH,
      alternateOwnerAddress: BURN_ADDRESS_BY_PROTOCOL.radix,
    },
    hyperlaneCore1,
    hyperlaneWarp,
  );
});
