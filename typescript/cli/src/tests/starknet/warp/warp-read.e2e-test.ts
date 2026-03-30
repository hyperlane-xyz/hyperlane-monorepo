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
} from '../../constants.js';
import { expectStarknetWarpConfig } from '../helpers.js';

describe('hyperlane warp read (Starknet E2E tests)', async function () {
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

  const WARP_CORE_PATH = getWarpCoreConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Starknet,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  let coreAddressByChain: ChainMap<ChainAddresses>;
  let warpDeployConfig: WarpRouteDeployConfig;
  let deployedWarpAddress: string;

  before(async function () {
    chain1CoreAddress = await hyperlaneCore1.deployOrUseExistingCore(
      HYP_KEY_BY_PROTOCOL.starknet,
    );

    coreAddressByChain = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: chain1CoreAddress,
    };

    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: {
        type: TokenType.native,
        mailbox: chain1CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        name: nativeTokenData.name,
        symbol: nativeTokenData.symbol,
        decimals: nativeTokenData.decimals,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
    const deployOutput = await hyperlaneWarp
      .deployRaw({
        warpRouteId: nativeTokenData.symbol,
        skipConfirmationPrompts: true,
        privateKey: HYP_KEY_BY_PROTOCOL.starknet,
      })
      .stdio('pipe');

    const deployedAddressMatch = deployOutput
      .text()
      .match(/addressOrDenom:\s+"(0x[0-9a-fA-F]+)"/);
    assert(deployedAddressMatch?.[1], 'Expected deployed warp address');
    deployedWarpAddress = deployedAddressMatch[1];
  });

  it('should read a Starknet warp route deployment', async () => {
    await hyperlaneWarp.readRaw({
      chain: TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      warpAddress: deployedWarpAddress,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const config: DerivedWarpRouteDeployConfig = readYamlOrJson(
      WARP_READ_OUTPUT_PATH,
    );

    for (const chainName of Object.keys(warpDeployConfig)) {
      expectStarknetWarpConfig(
        warpDeployConfig,
        config,
        coreAddressByChain,
        chainName,
        { expectConnections: false },
      );
    }
  });
});
