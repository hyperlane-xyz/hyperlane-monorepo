import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';

import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  CORE_PROTOCOL_ANVIL_STATE,
  ChainMetadata,
  HookType,
  HypTokenRouterConfig,
  HypTokenRouterConfigMailboxOptionalSchema,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  assert,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  E2E_TEST_BURN_ADDRESS,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  WARP_DEPLOY_2_ID,
  WARP_DEPLOY_OUTPUT_PATH,
  exportWarpConfigsToFilePaths,
  getCombinedWarpRoutePath,
  getDeployedWarpAddress,
  resetAnvilFork,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';

/**
 * Test Flow Overview:
 * - These tests run against local Anvil forks that are reset to a clean snapshot
 *   with only a warp route and the core protocol functionality deployed.
 * - The reset logic is in the beforeEach each hook which will:
 *    - reset the global warpConfig variable to the initial state
 *    - reset the config files in the test registry
 *    - reset the anvil fork to the initial state after the before hook runs
 *
 * Adding Your Own Tests:
 * - The warpConfig can be modified as needed as it will be reset to the expected initial state
 *   after the test runs
 * - Before calling warp apply use `writeYamlOrJson(...)` to persist any deploy config
 *   changes and be sure to supply the correct path to the command to read the deploy config.
 * - If a test that was working starts to fail, probably an incorrect deploy config is being
 *   used either because the path is wrong or the original config is not being reset in memory
 *   or on disk when read from the registry. Be sure to add any new path that might be used in
 *   new test to the reset logic to avoid test failing because of a previous test run
 */
describe('hyperlane warp apply e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain3Addresses: ChainAddresses = {};
  let chain2Metadata: ChainMetadata;
  let chain3Metadata: ChainMetadata;
  let warpDeployConfig: WarpRouteDeployConfig;
  let chain2Provider: JsonRpcProvider;
  let deployAnvilStateId: string;
  // it will be replaced at the first deployment
  let warpCoreConfig: WarpCoreConfig = { tokens: [] };
  let combinedWarpCoreConfigPath: string;

  const warpDeployConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

  function resetWarpConfig() {
    const rawWarpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    warpDeployConfig = {
      [CHAIN_NAME_2]: { ...rawWarpConfig.anvil1 },
    };

    writeYamlOrJson(WARP_CONFIG_PATH_2, warpDeployConfig);
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
    writeYamlOrJson(combinedWarpCoreConfigPath, warpCoreConfig);
    writeYamlOrJson(
      combinedWarpCoreConfigPath.replace('-config.yaml', '-deploy.yaml'),
      warpDeployConfig,
    );
  }

  before(async function () {
    chain2Metadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    chain3Metadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    chain3Addresses = CORE_PROTOCOL_ANVIL_STATE.addresses;

    combinedWarpCoreConfigPath = getCombinedWarpRoutePath('ETH', [
      CHAIN_NAME_2,
    ]);

    const currentWarpId = createWarpRouteConfigId('ETH', CHAIN_NAME_2);

    resetWarpConfig();
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2, currentWarpId);
    warpCoreConfig = readYamlOrJson(combinedWarpCoreConfigPath);

    chain2Provider = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    deployAnvilStateId = await chain2Provider.send('evm_snapshot', []);
  });

  // Reset config before each test to avoid test changes intertwining
  beforeEach(async function () {
    resetWarpConfig();

    deployAnvilStateId = await resetAnvilFork(
      chain2Provider,
      deployAnvilStateId,
    );
  });

  it('should burn owner address', async function () {
    warpDeployConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;
    writeYamlOrJson(warpDeployConfigPath, warpDeployConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const updatedWarpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );
    expect(updatedWarpDeployConfig.anvil2.owner).to.equal(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should not update the same owner', async () => {
    warpDeployConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;
    writeYamlOrJson(warpDeployConfigPath, warpDeployConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const { stdout } = await hyperlaneWarpApply(
      warpDeployConfigPath,
      WARP_CORE_CONFIG_PATH_2,
    );
    expect(stdout).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  it('should update the owner of both the warp token and the proxy admin', async () => {
    // Set to undefined if it was defined in the config
    warpDeployConfig[CHAIN_NAME_2].proxyAdmin = undefined;
    warpDeployConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;
    writeYamlOrJson(warpDeployConfigPath, warpDeployConfig);

    await hyperlaneWarpApply(
      warpDeployConfigPath,
      WARP_CORE_CONFIG_PATH_2,
      undefined,
      WARP_DEPLOY_2_ID,
    );

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(E2E_TEST_BURN_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should update only the owner of the warp token if the proxy admin config is specified', async () => {
    // Explicitly set it to the deployer address if it was not defined
    warpDeployConfig[CHAIN_NAME_2].proxyAdmin = {
      owner: ANVIL_DEPLOYER_ADDRESS,
    };
    warpDeployConfig[CHAIN_NAME_2].owner = E2E_TEST_BURN_ADDRESS;
    writeYamlOrJson(warpDeployConfigPath, warpDeployConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(E2E_TEST_BURN_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      ANVIL_DEPLOYER_ADDRESS,
    );
  });

  it('should update only the owner of the proxy admin if the proxy admin config is specified', async () => {
    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    warpConfig.anvil1.proxyAdmin = { owner: E2E_TEST_BURN_ADDRESS };
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(warpDeployConfigPath, anvil2Config);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(ANVIL_DEPLOYER_ADDRESS);
    expect(updatedWarpDeployConfig1.anvil2.proxyAdmin?.owner).to.eq(
      E2E_TEST_BURN_ADDRESS,
    );
  });

  it('should update hook configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // Update with a new hook config
    const owner = randomAddress();
    warpDeployConfig[CHAIN_NAME_2].hook = {
      type: HookType.PROTOCOL_FEE,
      beneficiary: owner,
      maxProtocolFee: '1000000',
      protocolFee: '100000',
      owner,
    };

    // Write the updated config
    await writeYamlOrJson(warpDeployPath, warpDeployConfig);

    // Apply the changes
    await hyperlaneWarpApply(warpDeployPath, WARP_CORE_CONFIG_PATH_2);

    // Read back the config to verify changes
    const updatedConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

    // Verify the hook was updated with all properties
    expect(normalizeConfig(updatedConfig[CHAIN_NAME_2].hook)).to.deep.equal(
      normalizeConfig(warpDeployConfig[CHAIN_NAME_2].hook),
    );
  });

  it('should extend a warp route with a custom warp route id', async () => {
    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    warpDeployConfig.anvil3 = config;

    // Copy over the warp deploy AND core to custom warp route id filepath
    // This simulates the user updating the warp route id in the registry
    const warpRouteId = 'ETH/custom-warp-route-id-2';
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH_2,
    );
    const { warpCorePath: updatedWarpCorePath } = exportWarpConfigsToFilePaths({
      warpRouteId,
      warpConfig: warpDeployConfig,
      warpCoreConfig,
    });

    // Apply
    await hyperlaneWarpApplyRaw({
      warpRouteId,
    });

    // getDeployedWarpAddress() throws if address does not exist
    const extendAddress = getDeployedWarpAddress(
      CHAIN_NAME_3,
      updatedWarpCorePath,
    );
    expect(extendAddress).to.be.exist;
    expect(extendAddress).to.not.equal(ethers.constants.AddressZero);
  });

  it('should apply changes to a warp route with a custom warp route id', async () => {
    // Update the existing warp route config
    warpDeployConfig.anvil2.owner = E2E_TEST_BURN_ADDRESS;

    // Copy over the warp deploy AND core to custom warp route id filepath
    // This simulates the user updating the warp route id in the registry
    const warpRouteId = 'ETH/custom-warp-route-id-2';
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH_2,
    );
    const {
      warpDeployPath: updatedWarpDeployPath,
      warpCorePath: updatedWarpCorePath,
    } = exportWarpConfigsToFilePaths({
      warpRouteId,
      warpCoreConfig,
      warpConfig: warpDeployConfig,
    });

    // Apply
    await hyperlaneWarpApplyRaw({
      warpRouteId,
    });

    const updatedWarpDeployConfig1 = await readWarpConfig(
      CHAIN_NAME_2,
      updatedWarpCorePath,
      updatedWarpDeployPath,
    );

    expect(updatedWarpDeployConfig1.anvil2.owner).to.eq(E2E_TEST_BURN_ADDRESS);
  });

  it('should add a new rebalancer and remove an existing one', async () => {
    const warpConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    // Add the first address as rebalancer and then remove it and add the second one
    const allowedRebalancers = [randomAddress(), randomAddress()].map(
      normalizeAddressEvm,
    );

    for (const rebalancer of allowedRebalancers) {
      const anvil2Config = {
        anvil2: { ...warpConfig.anvil1, allowedRebalancers: [rebalancer] },
      };
      writeYamlOrJson(warpConfigPath, anvil2Config);

      await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH_2);

      const updatedWarpDeployConfig = await readWarpConfig(
        CHAIN_NAME_2,
        WARP_CORE_CONFIG_PATH_2,
        warpConfigPath,
      );

      assert(
        updatedWarpDeployConfig.anvil2.type === TokenType.native,
        `Config on chain ${CHAIN_NAME_2} must be a ${TokenType.native}`,
      );
      expect(
        updatedWarpDeployConfig.anvil2.allowedRebalancers?.length,
      ).to.equal(1);

      const [currentRebalancer] =
        updatedWarpDeployConfig.anvil2.allowedRebalancers ?? [];
      expect(currentRebalancer).to.equal(rebalancer);
    }
  });

  const addAndRemoveBridgeTestCases = () => {
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

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
      const warpConfigPath = `${TEMP_PATH}/warp-route-deploy-config-2.yaml`;

      // Add the first address as rebalancer and then remove it and add the second one
      const allowedRebalancerBridges = [randomAddress(), randomAddress()].map(
        normalizeAddressEvm,
      );

      for (const rebalancer of allowedRebalancerBridges) {
        const anvil2Config: WarpRouteDeployConfig = {
          anvil2: HypTokenRouterConfigMailboxOptionalSchema.parse({
            ...warpDeployConfig.anvil2,
            owner: ANVIL_DEPLOYER_ADDRESS,
            remoteRouters: {
              [chain3DomainId]: { address: randomAddress() },
            },
            allowedRebalancingBridges: {
              [domainIdOrChainName]: [{ bridge: rebalancer }],
            },
          }),
        };
        writeYamlOrJson(warpConfigPath, anvil2Config);

        await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH_2);

        const updatedWarpDeployConfig = await readWarpConfig(
          CHAIN_NAME_2,
          WARP_CORE_CONFIG_PATH_2,
          warpConfigPath,
        );

        assert(
          updatedWarpDeployConfig.anvil2.type === TokenType.native,
          `Config on chain ${CHAIN_NAME_2} must be a ${TokenType.native}`,
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
    const expectedRemoteGasSetting = '30000';
    warpDeployConfig[CHAIN_NAME_2].destinationGas = {
      [CHAIN_NAME_3]: expectedRemoteGasSetting,
    };

    const expectedRemoteRouter = randomAddress();
    warpDeployConfig[CHAIN_NAME_2].remoteRouters = {
      [CHAIN_NAME_3]: {
        address: expectedRemoteRouter,
      },
    };

    // Write the updated config
    await writeYamlOrJson(warpDeployConfigPath, warpDeployConfig);

    await hyperlaneWarpApply(warpDeployConfigPath, WARP_CORE_CONFIG_PATH_2);
    const updatedConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployConfigPath,
    );

    expect(
      (updatedConfig[CHAIN_NAME_2].destinationGas ?? {})[
        chain3Metadata.domainId
      ],
    ).to.deep.equal(expectedRemoteGasSetting);
    expect(
      normalizeAddressEvm(
        (updatedConfig[CHAIN_NAME_2].remoteRouters ?? {})[
          chain3Metadata.domainId
        ].address,
      ),
    ).to.deep.equal(addressToBytes32(expectedRemoteRouter));
  });
});
