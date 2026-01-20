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

describe('hyperlane warp apply ownership (Aleo E2E tests)', async function () {
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

  before(async function () {
    await hyperlaneCore1.deploy(HYP_KEY_BY_PROTOCOL.aleo);
    await hyperlaneCore2.deploy(HYP_KEY_BY_PROTOCOL.aleo);

    chain1CoreAddress = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1}/addresses.yaml`,
    );
    chain2CoreAddress = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_2}/addresses.yaml`,
    );
  });

  let warpDeployConfig: WarpRouteDeployConfig;
  beforeEach(async () => {
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
    await hyperlaneWarp.deployRaw({
      warpRouteId: WARP_ROUTE_ID,
      skipConfirmationPrompts: true,
      privateKey: HYP_KEY_BY_PROTOCOL.aleo,
    });
  });

  it('should not update if there are no owner changes', async () => {
    const output = await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.aleo,
    });

    expect(output.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  const alternativeOwnerAddress1 =
    'aleo17m3l8a4hmf3wypzkf5lsausfdwq9etzyujd0vmqh35ledn2sgvqqzqkqal';
  const alternativeOwnerAddress2 =
    'aleo1vcyhz3cwu45js0sndl8hf7zzfg0slg20x8wjsv2r9q3havgzgupqxm0nad';

  const testCases: {
    description: string;
    chain1TokenOwner: string;
    chain2TokenOwner: string;
  }[] = [
    {
      description: 'should transfer ownership on chain 1',
      chain1TokenOwner: alternativeOwnerAddress1,
      chain2TokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
    },
    {
      description: 'should transfer ownership on chain 2',
      chain1TokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.aleo,
      chain2TokenOwner: alternativeOwnerAddress2,
    },
    {
      description: 'should transfer ownership of all the tokens',
      chain1TokenOwner: alternativeOwnerAddress1,
      chain2TokenOwner: alternativeOwnerAddress2,
    },
  ];

  for (const { description, chain1TokenOwner, chain2TokenOwner } of testCases) {
    it(description, async function () {
      const expectedChain1TokenOwner: Address = chain1TokenOwner;
      const expectedChain2TokenOwner: Address = chain2TokenOwner;

      warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1].owner =
        chain1TokenOwner;
      warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_2].owner =
        chain2TokenOwner;

      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      await hyperlaneWarp.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.aleo,
      });

      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
        readYamlOrJson(WARP_READ_OUTPUT_PATH);

      expect(
        updatedWarpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_1]
          .owner,
      ).to.eq(expectedChain1TokenOwner);
      expect(
        updatedWarpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.aleo.CHAIN_NAME_2]
          .owner,
      ).to.eq(expectedChain2TokenOwner);
    });
  }
});
