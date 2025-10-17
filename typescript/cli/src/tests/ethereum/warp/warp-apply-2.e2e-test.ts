import { expect } from 'chai';
import { ethers } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  HypTokenRouterConfig,
  HypTokenRouterConfigMailboxOptionalSchema,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  addressToBytes32,
  assert,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_CORE_PATH,
  DEFAULT_EVM_WARP_DEPLOY_PATH,
  DEFAULT_EVM_WARP_ID,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  DEPLOYER_ADDRESS_BY_PROTOCOL,
  E2E_BURN_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';
import {
  exportWarpConfigsToFilePaths,
  getDeployedWarpAddress,
} from '../../utils.js';

describe('hyperlane warp apply owner update tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);
  let chain3Addresses: ChainAddresses = {};
  const chain3Metadata: ChainMetadata =
    TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3;

  const evmChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );
  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
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

  let DEPLOYER_ADDRESS: string;
  let warpDeployConfig: WarpRouteDeployConfig;

  before(async function () {
    DEPLOYER_ADDRESS = await DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum();

    [, chain3Addresses] = await Promise.all([
      evmChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);
  });

  beforeEach(async function () {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: DEPLOYER_ADDRESS,
      },
    };
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.deploy(
      DEFAULT_EVM_WARP_DEPLOY_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );
  });

  it('should extend a warp route with a custom warp route id', async () => {
    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses.mailbox,
      name: 'Ether',
      owner: DEPLOYER_ADDRESS,
      symbol: 'ETH',
      type: TokenType.native,
    };
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      config;

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
    });

    // Apply
    await evmWarpCommands.applyRaw({
      warpRouteId,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    // getDeployedWarpAddress() throws if address does not exist
    const extendAddress = getDeployedWarpAddress(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      updatedWarpCorePath,
    );
    expect(extendAddress).to.be.exist;
    expect(extendAddress).to.not.equal(ethers.constants.AddressZero);
  });

  it('should apply changes to a warp route with a custom warp route id', async () => {
    // Update the existing warp route config
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].owner =
      E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum;

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
    });

    // Apply
    await evmWarpCommands.applyRaw({
      warpRouteId,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      updatedWarpCorePath,
    );

    expect(updatedWarpDeployConfig.anvil2.owner).to.eq(
      E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum,
    );
  });

  it('should add a new rebalancer and remove an existing one', async () => {
    const updatedWarpDeployConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // Add the first address as rebalancer and then remove it and add the second one
    const allowedRebalancers = [randomAddress(), randomAddress()].map(
      normalizeAddressEvm,
    );

    for (const rebalancer of allowedRebalancers) {
      const anvil2Config: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.native,
          owner: DEPLOYER_ADDRESS,
          allowedRebalancers: [rebalancer],
        },
      };

      writeYamlOrJson(updatedWarpDeployConfigPath, anvil2Config);

      await evmWarpCommands.applyRaw({
        warpDeployPath: updatedWarpDeployConfigPath,
        warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        DEFAULT_EVM_WARP_CORE_PATH,
      );

      const updatedChain2Config =
        updatedWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ];
      assert(
        updatedChain2Config.type === TokenType.native,
        `Config on chain ${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2} must be a ${TokenType.native}`,
      );
      expect(updatedChain2Config.allowedRebalancers?.length).to.equal(1);

      const [currentRebalancer] = updatedChain2Config.allowedRebalancers ?? [];
      expect(currentRebalancer).to.equal(rebalancer);
    }
  });

  const addAndRemoveBridgeTestCases = () => {
    return [
      [chain3Metadata.domainId, chain3Metadata.domainId],
      [chain3Metadata.domainId, chain3Metadata.name],
    ];
  };

  for (const [
    chain3DomainId,
    domainIdOrChainName,
  ] of addAndRemoveBridgeTestCases()) {
    it(`should add a new allowed bridge and remove an existing one for domain ${domainIdOrChainName}`, async () => {
      const updatedWarpDeployConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

      // Add the first address as rebalancer and then remove it and add the second one
      const allowedRebalancerBridges = [randomAddress(), randomAddress()].map(
        normalizeAddressEvm,
      );

      for (const rebalancer of allowedRebalancerBridges) {
        const anvil2Config: WarpRouteDeployConfig = {
          anvil2: HypTokenRouterConfigMailboxOptionalSchema.parse({
            type: TokenType.native,
            owner: DEPLOYER_ADDRESS,
            remoteRouters: {
              [chain3DomainId]: { address: randomAddress() },
            },
            allowedRebalancingBridges: {
              [domainIdOrChainName]: [{ bridge: rebalancer }],
            },
          }),
        };
        writeYamlOrJson(updatedWarpDeployConfigPath, anvil2Config);

        await evmWarpCommands.applyRaw({
          warpDeployPath: updatedWarpDeployConfigPath,
          warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
          hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
        });

        const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          DEFAULT_EVM_WARP_CORE_PATH,
        );

        assert(
          updatedWarpDeployConfig.anvil2.type === TokenType.native,
          `Config on chain ${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2} must be a ${TokenType.native}`,
        );
        expect(
          (updatedWarpDeployConfig.anvil2.allowedRebalancingBridges ?? {})[
            chain3DomainId
          ].length,
        ).to.equal(1);

        const [currentRebalancer] =
          (updatedWarpDeployConfig.anvil2.allowedRebalancingBridges ?? {})[
            chain3DomainId
          ] ?? [];
        expect(currentRebalancer.bridge).to.equal(rebalancer);
      }
    });
  }

  it('should update the remote gas and routers configuration when specified using the domain name', async () => {
    const updatedWarpDeployConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    const expectedRemoteGasSetting = '30000';
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
    await writeYamlOrJson(updatedWarpDeployConfigPath, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpDeployPath: updatedWarpDeployConfigPath,
      warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const updatedConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    expect(
      (updatedConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
        .destinationGas ?? {})[chain3Metadata.domainId],
    ).to.deep.equal(expectedRemoteGasSetting);
    expect(
      normalizeAddressEvm(
        (updatedConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .remoteRouters ?? {})[chain3Metadata.domainId].address,
      ),
    ).to.deep.equal(addressToBytes32(expectedRemoteRouter));
  });
});
