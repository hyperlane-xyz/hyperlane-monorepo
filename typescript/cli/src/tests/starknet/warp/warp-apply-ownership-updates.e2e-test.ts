import { expect } from 'chai';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type DerivedWarpRouteDeployConfig,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
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
import { normalizeStarknetAddress } from '../helpers.js';

describe('hyperlane warp apply ownership (Starknet E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

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

  before(async function () {
    [chain1CoreAddress, chain2CoreAddress] = await Promise.all([
      hyperlaneCore1.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
      hyperlaneCore2.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
    ]);
  });

  let warpDeployConfig: WarpRouteDeployConfig;
  beforeEach(async () => {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: {
        type: TokenType.native,
        mailbox: chain1CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: chain2CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        name: nativeTokenData.name,
        symbol: nativeTokenData.symbol,
        decimals: nativeTokenData.decimals,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
    await hyperlaneWarp.deployRaw({
      warpRouteId: WARP_ROUTE_ID,
      skipConfirmationPrompts: true,
      privateKey: HYP_KEY_BY_PROTOCOL.starknet,
    });
  });

  it('should not update if there are no owner changes', async () => {
    const output = await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    expect(output.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  const testCases: {
    description: string;
    chain1TokenOwner: Address;
    chain2TokenOwner: Address;
  }[] = [
    {
      description: 'should transfer ownership on starknet1',
      chain1TokenOwner: BURN_ADDRESS_BY_PROTOCOL.starknet,
      chain2TokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
    },
    {
      description: 'should transfer ownership on starknet2',
      chain1TokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      chain2TokenOwner: BURN_ADDRESS_BY_PROTOCOL.starknet,
    },
    {
      description: 'should transfer ownership of all Starknet warp tokens',
      chain1TokenOwner: BURN_ADDRESS_BY_PROTOCOL.starknet,
      chain2TokenOwner: BURN_ADDRESS_BY_PROTOCOL.starknet,
    },
  ];

  for (const { description, chain1TokenOwner, chain2TokenOwner } of testCases) {
    it(description, async () => {
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1
      ].owner = chain1TokenOwner;
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2
      ].owner = chain2TokenOwner;

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

      expect(
        normalizeStarknetAddress(
          updatedWarpDeployConfig[
            TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1
          ].owner,
        ),
      ).to.equal(normalizeStarknetAddress(chain1TokenOwner));
      expect(
        normalizeStarknetAddress(
          updatedWarpDeployConfig[
            TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2
          ].owner,
        ),
      ).to.equal(normalizeStarknetAddress(chain2TokenOwner));
    });
  }
});
