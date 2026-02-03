import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type DerivedWarpRouteDeployConfig,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  readYamlOrJsonOrThrow,
  writeYamlOrJson,
} from '../../../utils/files.js';
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
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { assertWarpRouteConfig } from '../../utils.js';

describe('hyperlane warp apply (Radix E2E tests)', async function () {
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

  let chain2CoreAddress: ChainAddresses;
  const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Radix,
    TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.radix,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.radix.CHAIN_NAME_2,
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

  let coreAddressByChain: ChainMap<ChainAddresses>;

  before(async function () {
    [chain1CoreAddress, chain2CoreAddress] = await Promise.all([
      hyperlaneCore1.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.radix),
      hyperlaneCore2.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.radix),
    ]);

    coreAddressByChain = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]: chain1CoreAddress,
      [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2]: chain2CoreAddress,
    };
  });

  let warpDeployConfig: WarpRouteDeployConfig;
  beforeEach(async () => {
    warpDeployConfig = {
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

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
    await hyperlaneWarp.deployRaw({
      warpRouteId: WARP_ROUTE_ID,
      skipConfirmationPrompts: true,
      privateKey: HYP_KEY_BY_PROTOCOL.radix,
    });
  });

  it(`It should extend the route to a new chain`, async function () {
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2] = {
      type: TokenType.synthetic,
      mailbox: chain2CoreAddress.mailbox,
      owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
      name: nativeTokenData.name,
      symbol: nativeTokenData.symbol,
      decimals: nativeTokenData.decimals,
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.radix,
    });

    await hyperlaneWarp.readRaw({
      warpRouteId: WARP_ROUTE_ID,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const updatedWarpDeployConfig =
      readYamlOrJsonOrThrow<DerivedWarpRouteDeployConfig>(
        WARP_READ_OUTPUT_PATH,
      );

    for (const chainName of Object.keys(warpDeployConfig)) {
      assertWarpRouteConfig(
        warpDeployConfig,
        updatedWarpDeployConfig,
        coreAddressByChain,
        chainName,
      );
    }
  });
});
