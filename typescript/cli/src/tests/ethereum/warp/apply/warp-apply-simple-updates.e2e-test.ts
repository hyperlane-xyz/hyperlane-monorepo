import { expect } from 'chai';
import { ethers } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HypTokenRouterConfig,
  TokenType,
  WarpCoreConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  addressToBytes32,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../../utils/files.js';
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
import { exportWarpConfigsToFilePaths } from '../../commands/helpers.js';
import { WarpTestFixture } from '../../fixtures/warp-test-fixture.js';

describe('hyperlane warp apply owner update tests', async function () {
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

  let chain3Addresses: ChainAddresses;
  const chain3Metadata = TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3;

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const evmChain3Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    [, chain3Addresses] = await Promise.all([
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain3Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

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

  it('should extend a warp route with a custom warp route id', async () => {
    // Extend with new config
    const chain3Config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      symbol: 'ETH',
      type: TokenType.native,
    };

    const warpDeployConfig = fixture.getDeployConfig();
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      chain3Config;

    // Copy over the warp deploy AND core to custom warp route id filepath
    // This simulates the user updating the warp route id in the registry
    const warpRouteId = 'ETH/custom-warp-route-id-2';
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      DEFAULT_EVM_WARP_CORE_PATH,
    );
    const { warpCorePath: updatedWarpCorePath } = exportWarpConfigsToFilePaths({
      warpRouteId,
      warpConfig: warpDeployConfig,
      warpCoreConfig,
      registryPath: REGISTRY_PATH,
    });

    // Apply
    await evmWarpCommands.applyRaw({
      warpRouteId,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    // getDeployedWarpAddress() throws if address does not exist
    const extendAddress = evmWarpCommands.getDeployedWarpAddress(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      updatedWarpCorePath,
    );
    expect(extendAddress).to.be.exist;
    expect(extendAddress).to.not.equal(ethers.constants.AddressZero);
  });

  it('should apply changes to a warp route with a custom warp route id', async () => {
    // Update the existing warp route config
    const warpDeployConfig = fixture.getDeployConfig();
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].owner =
      BURN_ADDRESS_BY_PROTOCOL.ethereum;

    // Copy over the warp deploy AND core to custom warp route id filepath
    // This simulates the user updating the warp route id in the registry
    const warpRouteId = 'ETH/custom-warp-route-id-2';
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      DEFAULT_EVM_WARP_CORE_PATH,
    );
    const { warpCorePath: updatedWarpCorePath } = exportWarpConfigsToFilePaths({
      warpRouteId,
      warpCoreConfig,
      warpConfig: warpDeployConfig,
      registryPath: REGISTRY_PATH,
    });

    // Apply
    await evmWarpCommands.applyRaw({
      warpRouteId: warpRouteId,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      updatedWarpCorePath,
    );

    expect(
      updatedWarpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].owner,
    ).to.eq(BURN_ADDRESS_BY_PROTOCOL.ethereum);
  });

  it('should update the remote gas and routers configuration when specified using the domain name', async () => {
    const expectedRemoteGasSetting = '30000';
    const warpDeployConfig = fixture.getDeployConfig();
    warpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].destinationGas = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]:
        expectedRemoteGasSetting,
    };

    const expectedRemoteRouter = randomAddress();
    warpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].remoteRouters = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        address: expectedRemoteRouter,
      },
    };

    // Write the updated config
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
      (updatedWarpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].destinationGas ?? {})[chain3Metadata.domainId],
    ).to.deep.equal(expectedRemoteGasSetting);
    expect(
      normalizeAddressEvm(
        (updatedWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].remoteRouters ?? {})[chain3Metadata.domainId].address,
      ),
    ).to.deep.equal(addressToBytes32(expectedRemoteRouter));
  });
});
