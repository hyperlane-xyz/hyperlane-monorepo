import { expect } from 'chai';

import { TokenType, randomAddress } from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, normalizeAddress } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../../commands/warp.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_CORE_PATH,
  DEFAULT_EVM_WARP_DEPLOY_PATH,
  DEFAULT_EVM_WARP_ID,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../../constants.js';
import { WarpTestFixture } from '../../fixtures/warp-test-fixture.js';

describe('hyperlane warp apply E2E (ownership updates)', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const fixture = new WarpTestFixture({
    initialDeployConfig: {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
    },
    deployConfigPath: DEFAULT_EVM_WARP_DEPLOY_PATH,
    coreConfigPath: DEFAULT_EVM_WARP_CORE_PATH,
  });

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    await evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum);

    fixture.writeConfigs();
    await evmWarpCommands.deploy(
      DEFAULT_EVM_WARP_DEPLOY_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    fixture.loadCoreConfig();
    await fixture.createSnapshot({
      rpcUrl: TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    });
  });

  beforeEach(async function () {
    fixture.restoreConfigs();
    await fixture.restoreSnapshot({
      rpcUrl: TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    });
  });

  it('should not update the same owner', async () => {
    const output = await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    expect(output.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  const testCases: {
    description: string;
    tokenOwner: string;
    proxyAdminOwner?: string;
  }[] = [
    {
      description: 'should burn owner address',
      tokenOwner: BURN_ADDRESS_BY_PROTOCOL.ethereum,
    },
    {
      description:
        'should update the owner of both the warp token and the proxy admin',
      tokenOwner: randomAddress(),
    },
    {
      description:
        'should update only the owner of the warp token if the proxy admin config is specified',
      proxyAdminOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      tokenOwner: randomAddress(),
    },
    {
      description:
        'should update only the owner of the proxy admin if the proxy admin config is specified',
      tokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      proxyAdminOwner: randomAddress(),
    },
  ];

  for (const { description, proxyAdminOwner, tokenOwner } of testCases) {
    it(description, async function () {
      const expectedTokenOwner: Address = tokenOwner;
      const expectedProxyAdminOwner: Address =
        proxyAdminOwner ?? expectedTokenOwner;

      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].owner = tokenOwner;

      if (proxyAdminOwner) {
        warpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].proxyAdmin = { owner: proxyAdminOwner };
      }
      writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

      await evmWarpCommands.applyRaw({
        warpRouteId: DEFAULT_EVM_WARP_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        DEFAULT_EVM_WARP_CORE_PATH,
      );

      expect(
        normalizeAddress(
          updatedWarpDeployConfig[
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
          ].owner,
        ),
      ).to.eq(normalizeAddress(expectedTokenOwner));
      expect(
        normalizeAddress(
          updatedWarpDeployConfig[
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
          ].proxyAdmin!.owner,
        ),
      ).to.eq(normalizeAddress(expectedProxyAdminOwner));
    });
  }
});
