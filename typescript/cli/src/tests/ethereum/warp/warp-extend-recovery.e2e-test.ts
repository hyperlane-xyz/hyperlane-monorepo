import { expect } from 'chai';
import { Wallet } from 'ethers';

import { TokenRouter__factory } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HypTokenRouterConfig,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_ID,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  getWarpCoreConfigPath,
} from '../../constants.js';
import { setupIncompleteWarpRouteExtension } from '../../utils.js';
import { getDomainId } from '../commands/helpers.js';

describe('hyperlane warp apply recovery extension tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let warpDeployConfig: WarpRouteDeployConfig;

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

    ownerAddress = await DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum();
  });

  beforeEach(async function () {
    const warpConfig2Path = `${TEMP_PATH}/${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2}/warp-route-deployment-anvil2.yaml`;

    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(warpConfig2Path, warpDeployConfig);
    await evmWarpCommands.deploy(
      warpConfig2Path,
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );
  });

  it('should recover and re-enroll routers after direct contract-level unenrollment through TokenRouter interface', async () => {
    const { multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpCoreConfig2Path = getWarpCoreConfigPath('ETH', [
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    ]);

    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      config;
    writeYamlOrJson(warpConfigPath, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpDeployPath: warpConfigPath,
      warpCorePath: warpCoreConfig2Path,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = getWarpCoreConfigPath('ETH', [
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    ]);

    const warpCoreConfig = readYamlOrJson(
      COMBINED_WARP_CORE_CONFIG_PATH,
    ) as WarpCoreConfig;
    const deployedTokenRoute = warpCoreConfig.tokens.find(
      (t) => t.chainName === TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    )?.addressOrDenom;

    if (!deployedTokenRoute) {
      throw new Error('Failed to find deployed token route address');
    }

    // Manually call unenrollRemoteRouters
    const chain3Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );
    const tokenRouter = TokenRouter__factory.connect(
      deployedTokenRoute,
      new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).connect(
        multiProvider.getProvider(
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        ),
      ),
    );
    await tokenRouter.unenrollRemoteRouters([chain3Id]);

    // Verify the router was unenrolled
    const beforeRecoveryConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
    );
    expect(
      Object.keys(
        beforeRecoveryConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .remoteRouters || {},
      ),
    ).to.not.include(chain3Id.toString());

    // Re-extend to fix the configuration
    await evmWarpCommands.applyRaw({
      warpDeployPath: warpConfigPath,
      warpCorePath: warpCoreConfig2Path,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    const recoveredConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
    );

    expect(
      Object.keys(
        recoveredConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .remoteRouters!,
      ),
    ).to.include(chain3Id.toString());
  });

  it('should complete warp route extension when previous attempt left incomplete enrollment or destination gas settings (second attempt on new combined config)', async () => {
    const {
      chain2DomainId,
      chain3DomainId,
      warpConfigPath,
      configToExtend,
      combinedWarpCorePath,
    } = await setupIncompleteWarpRouteExtension(
      chain3Addresses,
      evmWarpCommands,
    );

    // Verify initial state - neither chain should be enrolled in the other
    const initialConfig2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      combinedWarpCorePath,
    );
    const initialConfig3 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      combinedWarpCorePath,
    );

    // Check remote routers initial state
    expect(
      Object.keys(
        initialConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .remoteRouters!,
      ),
    ).to.not.include(chain3DomainId);
    expect(
      Object.keys(
        initialConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .remoteRouters!,
      ),
    ).to.not.include(chain2DomainId);

    // Check destination gas initial state
    expect(
      Object.keys(
        initialConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .destinationGas || {},
      ),
    ).to.not.include(chain3DomainId);
    expect(
      Object.keys(
        initialConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .destinationGas || {},
      ),
    ).to.not.include(chain2DomainId);

    // Complete the extension
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      configToExtend;
    writeYamlOrJson(warpConfigPath, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpDeployPath: warpConfigPath,
      warpCorePath: combinedWarpCorePath,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    // Verify both chains are now properly configured
    const finalConfig2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      combinedWarpCorePath,
    );
    const finalConfig3 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      combinedWarpCorePath,
    );

    // Check remote routers final state
    expect(
      Object.keys(
        finalConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .remoteRouters!,
      ),
    ).to.include(chain3DomainId);
    expect(
      Object.keys(
        finalConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .remoteRouters!,
      ),
    ).to.include(chain2DomainId);

    // Check destination gas final state
    expect(
      Object.keys(
        finalConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .destinationGas!,
      ),
    ).to.include(chain3DomainId);
    expect(
      Object.keys(
        finalConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .destinationGas!,
      ),
    ).to.include(chain2DomainId);
  });

  it('should complete warp route extension when previous attempt left incomplete enrollment or destination gas settings (second attempt with same config)', async () => {
    const {
      chain2DomainId,
      chain3DomainId,
      warpConfigPath,
      configToExtend,
      combinedWarpCorePath,
    } = await setupIncompleteWarpRouteExtension(
      chain3Addresses,
      evmWarpCommands,
    );

    // Verify initial state - neither chain should be enrolled in the other
    const initialConfig2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      combinedWarpCorePath,
    );
    const initialConfig3 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      combinedWarpCorePath,
    );
    // Check remote routers initial state
    expect(
      Object.keys(
        initialConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .remoteRouters!,
      ),
    ).to.not.include(chain3DomainId);
    expect(
      Object.keys(
        initialConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .remoteRouters!,
      ),
    ).to.not.include(chain2DomainId);

    // Check destination gas initial state
    expect(
      Object.keys(
        initialConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .destinationGas || {},
      ),
    ).to.not.include(chain3DomainId);
    expect(
      Object.keys(
        initialConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .destinationGas || {},
      ),
    ).to.not.include(chain2DomainId);

    // Complete the extension
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      configToExtend;
    writeYamlOrJson(warpConfigPath, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpDeployPath: warpConfigPath,
      warpCorePath: combinedWarpCorePath,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    // Verify both chains are now properly configured
    const finalConfig2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      combinedWarpCorePath,
    );
    const finalConfig3 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      combinedWarpCorePath,
    );

    // Check remote routers final state
    expect(
      Object.keys(
        finalConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .remoteRouters!,
      ),
    ).to.include(chain3DomainId);
    expect(
      Object.keys(
        finalConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .remoteRouters!,
      ),
    ).to.include(chain2DomainId);

    // Check destination gas final state
    expect(
      Object.keys(
        finalConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .destinationGas!,
      ),
    ).to.include(chain3DomainId);
    expect(
      Object.keys(
        finalConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .destinationGas!,
      ),
    ).to.include(chain2DomainId);
  });

  it('should set correct gas values when completing warp route extension', async () => {
    const {
      chain2DomainId,
      chain3DomainId,
      warpConfigPath,
      configToExtend,
      combinedWarpCorePath,
    } = await setupIncompleteWarpRouteExtension(
      chain3Addresses,
      evmWarpCommands,
    );

    // Verify initial state - gas values should not be set
    const initialConfig2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      combinedWarpCorePath,
    );
    const initialConfig3 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      combinedWarpCorePath,
    );

    // Check initial gas values
    expect(
      initialConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
        .destinationGas?.[chain3DomainId],
    ).to.be.undefined;
    expect(
      initialConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
        .destinationGas?.[chain2DomainId],
    ).to.be.undefined;

    // Set specific gas values for the extension
    const customGasValue = '300000';
    configToExtend.gas = parseInt(customGasValue);

    // Complete the extension with custom gas value
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      configToExtend;
    writeYamlOrJson(warpConfigPath, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpDeployPath: warpConfigPath,
      warpCorePath: combinedWarpCorePath,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    // Verify gas values are correctly set after extension
    const finalConfig2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      combinedWarpCorePath,
    );
    const finalConfig3 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      combinedWarpCorePath,
    );

    // Check gas value is set correctly
    expect(
      finalConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
        .destinationGas![chain3DomainId],
    ).to.equal(customGasValue);

    // Verify remote routers are also properly set
    expect(
      Object.keys(
        finalConfig2[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .remoteRouters!,
      ),
    ).to.include(chain3DomainId);
    expect(
      Object.keys(
        finalConfig3[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]
          .remoteRouters!,
      ),
    ).to.include(chain2DomainId);
  });
});
