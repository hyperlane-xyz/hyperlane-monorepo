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
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  STARKNET_E2E_TEST_TIMEOUT,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { expectStarknetWarpConfig } from '../helpers.js';

describe('hyperlane warp apply route extension (Starknet E2E tests)', async function () {
  this.timeout(STARKNET_E2E_TEST_TIMEOUT);

  const nativeTokenData =
    TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1.nativeToken;
  assert(nativeTokenData?.denom, 'Expected Starknet native token denom');

  let chain1CoreAddress: ChainAddresses;
  const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  );

  let chain2CoreAddress: ChainAddresses;
  const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_2,
  );

  const WARP_CORE_PATH = getWarpCoreConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Starknet,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  let coreAddressByChain: ChainMap<ChainAddresses>;
  let warpDeployConfig: WarpRouteDeployConfig;

  before(async function () {
    [chain1CoreAddress, chain2CoreAddress] = await Promise.all([
      hyperlaneCore1.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
      hyperlaneCore2.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
    ]);

    coreAddressByChain = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: chain1CoreAddress,
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2]: chain2CoreAddress,
    };
  });

  beforeEach(async () => {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: {
        type: TokenType.native,
        mailbox: chain1CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
    await hyperlaneWarp.deployRaw({
      warpRouteId: WARP_ROUTE_ID,
      skipConfirmationPrompts: true,
      privateKey: HYP_KEY_BY_PROTOCOL.starknet,
    });
  });

  it('should extend the route to a new Starknet chain', async function () {
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2] = {
      type: TokenType.synthetic,
      mailbox: chain2CoreAddress.mailbox,
      owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      name: nativeTokenData.name,
      symbol: nativeTokenData.symbol,
      decimals: nativeTokenData.decimals,
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    await hyperlaneWarp.readRaw({
      warpRouteId: WARP_ROUTE_ID,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
      readYamlOrJson(WARP_READ_OUTPUT_PATH);

    for (const chainName of Object.keys(warpDeployConfig)) {
      expectStarknetWarpConfig(
        warpDeployConfig,
        updatedWarpDeployConfig,
        coreAddressByChain,
        chainName,
      );
    }
  });
});
