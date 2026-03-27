import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
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

type SingleChainWarpApplyTestContext = {
  chainName: string;
  warpDeployConfig: WarpRouteDeployConfig;
  writeWarpDeployConfig: () => void;
  applyWarpConfig: () => Promise<void>;
  readWarpConfig: () => Promise<DerivedWarpRouteDeployConfig>;
};

type DualChainWarpApplyTestContext = {
  chainName1: string;
  chainName2: string;
  warpDeployConfig: WarpRouteDeployConfig;
  writeWarpDeployConfig: () => void;
  applyWarpConfig: () => Promise<void>;
  readWarpConfig: () => Promise<DerivedWarpRouteDeployConfig>;
};

export function describeStarknetSingleChainWarpApplyTest(
  suiteTitle: string,
  testTitle: string,
  test: (context: SingleChainWarpApplyTestContext) => Promise<void>,
) {
  describe(suiteTitle, function () {
    this.timeout(STARKNET_E2E_TEST_TIMEOUT);

    const chainName = TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1;
    const nativeTokenData =
      TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1.nativeToken;
    assert(nativeTokenData?.denom, 'Expected Starknet native token denom');

    let chainCoreAddress: ChainAddresses;
    const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Starknet,
      chainName,
      REGISTRY_PATH,
      CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    );

    const warpCorePath = getWarpCoreConfigPath(nativeTokenData.symbol, [
      chainName,
    ]);
    const warpDeployPath = getWarpDeployConfigPath(nativeTokenData.symbol, [
      chainName,
    ]);
    const warpRouteId = getWarpId(nativeTokenData.symbol, [chainName]);

    const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
      ProtocolType.Starknet,
      REGISTRY_PATH,
      warpCorePath,
    );

    let warpDeployConfig: WarpRouteDeployConfig;

    before(async function () {
      chainCoreAddress = await hyperlaneCore.deployOrUseExistingCore(
        HYP_KEY_BY_PROTOCOL.starknet,
      );
    });

    beforeEach(async () => {
      warpDeployConfig = {
        [chainName]: {
          type: TokenType.native,
          mailbox: chainCoreAddress.mailbox,
          owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
          name: nativeTokenData.name,
          symbol: nativeTokenData.symbol,
          decimals: nativeTokenData.decimals,
        },
      };

      writeYamlOrJson(warpDeployPath, warpDeployConfig);
      await hyperlaneWarp.deployRaw({
        warpRouteId,
        skipConfirmationPrompts: true,
        privateKey: HYP_KEY_BY_PROTOCOL.starknet,
      });
    });

    async function applyWarpConfig() {
      await hyperlaneWarp.applyRaw({
        warpRouteId,
        hypKey: HYP_KEY_BY_PROTOCOL.starknet,
        skipConfirmationPrompts: true,
      });
    }

    async function readWarpConfig() {
      await hyperlaneWarp.readRaw({
        warpRouteId,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      return readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      ) as DerivedWarpRouteDeployConfig;
    }

    it(testTitle, async () => {
      await test({
        chainName,
        warpDeployConfig,
        writeWarpDeployConfig: () =>
          writeYamlOrJson(warpDeployPath, warpDeployConfig),
        applyWarpConfig,
        readWarpConfig,
      });
    });
  });
}

export function describeStarknetDualChainWarpApplyTest(
  suiteTitle: string,
  testTitle: string,
  test: (context: DualChainWarpApplyTestContext) => Promise<void>,
) {
  describe(suiteTitle, function () {
    this.timeout(STARKNET_E2E_TEST_TIMEOUT);

    const chainName1 = TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1;
    const chainName2 = TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2;
    const nativeTokenData =
      TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1.nativeToken;
    assert(nativeTokenData?.denom, 'Expected Starknet native token denom');

    let chain1CoreAddress: ChainAddresses;
    const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Starknet,
      chainName1,
      REGISTRY_PATH,
      CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    );

    let chain2CoreAddress: ChainAddresses;
    const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Starknet,
      chainName2,
      REGISTRY_PATH,
      CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_2,
    );

    const warpCorePath = getWarpCoreConfigPath(nativeTokenData.symbol, [
      chainName1,
    ]);
    const warpDeployPath = getWarpDeployConfigPath(nativeTokenData.symbol, [
      chainName1,
    ]);
    const warpRouteId = getWarpId(nativeTokenData.symbol, [chainName1]);

    const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
      ProtocolType.Starknet,
      REGISTRY_PATH,
      warpCorePath,
    );

    let warpDeployConfig: WarpRouteDeployConfig;

    before(async function () {
      [chain1CoreAddress, chain2CoreAddress] = await Promise.all([
        hyperlaneCore1.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
        hyperlaneCore2.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
      ]);
    });

    beforeEach(async () => {
      warpDeployConfig = {
        [chainName1]: {
          type: TokenType.native,
          mailbox: chain1CoreAddress.mailbox,
          owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        },
        [chainName2]: {
          type: TokenType.synthetic,
          mailbox: chain2CoreAddress.mailbox,
          owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
          name: nativeTokenData.name,
          symbol: nativeTokenData.symbol,
          decimals: nativeTokenData.decimals,
        },
      };

      writeYamlOrJson(warpDeployPath, warpDeployConfig);
      await hyperlaneWarp.deployRaw({
        warpRouteId,
        skipConfirmationPrompts: true,
        privateKey: HYP_KEY_BY_PROTOCOL.starknet,
      });
    });

    async function applyWarpConfig() {
      await hyperlaneWarp.applyRaw({
        warpRouteId,
        hypKey: HYP_KEY_BY_PROTOCOL.starknet,
        skipConfirmationPrompts: true,
      });
    }

    async function readWarpConfig() {
      await hyperlaneWarp.readRaw({
        warpRouteId,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      return readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      ) as DerivedWarpRouteDeployConfig;
    }

    it(testTitle, async () => {
      await test({
        chainName1,
        chainName2,
        warpDeployConfig,
        writeWarpDeployConfig: () =>
          writeYamlOrJson(warpDeployPath, warpDeployConfig),
        applyWarpConfig,
        readWarpConfig,
      });
    });
  });
}
