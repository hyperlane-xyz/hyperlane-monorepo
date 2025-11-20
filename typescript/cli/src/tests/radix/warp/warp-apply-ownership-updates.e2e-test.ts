import { expect } from 'chai';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  DerivedWarpRouteDeployConfig,
  TokenType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

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

  before(async function () {
    [chain1CoreAddress, chain2CoreAddress] = await Promise.all([
      hyperlaneCore1.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.radix),
      hyperlaneCore2.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.radix),
    ]);
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
      [TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: chain2CoreAddress.mailbox,
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

  it('should not update if there are no owner changes', async () => {
    const output = await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.radix,
    });

    expect(output.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  const testCases: {
    description: string;
    chain1TokenOwner: string;
    chain2TokenOwner: string;
  }[] = [
    {
      description: 'should burn owner address on chain 1',
      chain1TokenOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
      chain2TokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
    },
    {
      description: 'should burn owner address on chain 2',
      chain1TokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.radix,
      chain2TokenOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
    },
    {
      description: 'should transfer ownership of all the tokens',
      chain1TokenOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
      chain2TokenOwner: BURN_ADDRESS_BY_PROTOCOL.radix,
    },
  ];

  for (const { description, chain1TokenOwner, chain2TokenOwner } of testCases) {
    it(description, async function () {
      const expectedChain1TokenOwner: Address = chain1TokenOwner;
      const expectedChain2TokenOwner: Address = chain2TokenOwner;

      warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1].owner =
        chain1TokenOwner;
      warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2].owner =
        chain2TokenOwner;

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.radix,
      });

      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(WARP_READ_OUTPUT_PATH);

      expect(
        updatedWarpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_1]
          .owner,
      ).to.eq(expectedChain1TokenOwner);
      expect(
        updatedWarpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.radix.CHAIN_NAME_2]
          .owner,
      ).to.eq(expectedChain2TokenOwner);
    });
  }
});
