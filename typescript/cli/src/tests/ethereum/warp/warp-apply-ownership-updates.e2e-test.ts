import { expect } from 'chai';

import {
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, normalizeAddress } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
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
} from '../../constants.js';
import { createSnapshot, restoreSnapshot } from '../commands/helpers.js';

describe('hyperlane warp apply E2E (ownership updates)', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let warpDeployConfig: WarpRouteDeployConfig;
  let warpCoreConfig: WarpCoreConfig;
  let chain2SnapshotId: string;

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

  function restoreWarpRouteConfig() {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
    };
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    if (warpCoreConfig) {
      writeYamlOrJson(DEFAULT_EVM_WARP_CORE_PATH, warpCoreConfig);
    }
  }

  before(async function () {
    await evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum);

    restoreWarpRouteConfig();
    await evmWarpCommands.deploy(
      DEFAULT_EVM_WARP_DEPLOY_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    warpCoreConfig = readYamlOrJson(DEFAULT_EVM_WARP_CORE_PATH);

    // Create a snapshot of the current chain state so that it can be restored before each test run
    chain2SnapshotId = await createSnapshot(
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
    );
  });

  // Restore the chain to the state after running
  // the before hook so no need to redeploy for each test
  beforeEach(async function () {
    restoreWarpRouteConfig();

    await restoreSnapshot(
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
      chain2SnapshotId,
    );
    chain2SnapshotId = await createSnapshot(
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
    );
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
