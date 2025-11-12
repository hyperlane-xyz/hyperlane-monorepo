import { expect } from 'chai';

import {
  HookType,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../../commands/warp.js';
import {
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
import { createSnapshot, restoreSnapshot } from '../../commands/helpers.js';

describe('hyperlane warp apply E2E (hook updates)', async function () {
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

  it('should update hook configuration', async () => {
    // Update with a new hook config
    const owner = randomAddress();
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].hook =
      {
        type: HookType.PROTOCOL_FEE,
        beneficiary: owner,
        maxProtocolFee: '1000000',
        protocolFee: '100000',
        owner,
      };

    // Write the updated config
    await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    // Apply the changes
    await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    // Verify the hook was updated with all properties
    expect(
      normalizeConfig(
        updatedWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].hook,
      ),
    ).to.deep.equal(
      normalizeConfig(
        warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .hook,
      ),
    );
  });
});
