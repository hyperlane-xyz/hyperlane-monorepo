import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Wallet, ethers } from 'ethers';

import {
  ERC20Test,
  EverclearTokenBridge__factory,
  MockEverclearAdapter,
} from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  EverclearCollateralTokenConfig,
  HypTokenRouterConfig,
  HypTokenRouterConfigMailboxOptionalSchema,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  addressToBytes32,
  assert,
  normalizeAddressEvm,
  randomInt,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH,
  deployEverclearBridgeAdapter,
  deployToken,
  exportWarpConfigsToFilePaths,
  getDeployedWarpAddress,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  E2E_TEST_BURN_ADDRESS,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  WARP_CORE_CONFIG_PATH_2,
  WARP_DEPLOY_2_ID,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../consts.js';

describe('hyperlane warp apply owner update tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);
  let chain3Addresses: ChainAddresses = {};
  let chain3Metadata: ChainMetadata;
  let chain3DomainId: number;

  let tokenChain2: ERC20Test;
  let everclearBridgeAdapterMock: MockEverclearAdapter;

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let providerChain2: JsonRpcProvider;

  before(async function () {
    await deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY);
    chain3Metadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    chain3DomainId = chain3Metadata.domainId;

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    ownerAddress = walletChain2.address;

    tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    everclearBridgeAdapterMock = await deployEverclearBridgeAdapter(
      ANVIL_KEY,
      CHAIN_NAME_2,
    );

    chain3Addresses = await deployOrUseExistingCore(
      CHAIN_NAME_3,
      CORE_CONFIG_PATH,
      ANVIL_KEY,
    );

    // Create a new warp config using the example
    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );
    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);
  });

  beforeEach(async function () {
    await hyperlaneWarpDeploy(WARP_CONFIG_PATH_2, WARP_DEPLOY_2_ID);
  });

  it('should extend a warp route with a custom warp route id', async () => {
    // Read existing config
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );

    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(ANVIL_KEY).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    warpConfig.anvil3 = config;

    // Copy over the warp deploy AND core to custom warp route id filepath
    // This simulates the user updating the warp route id in the registry
    const warpRouteId = 'ETH/custom-warp-route-id-2';
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH_2,
    );
    const { warpCorePath: updatedWarpCorePath } = exportWarpConfigsToFilePaths({
      warpRouteId,
      warpConfig,
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
    // Read existing config
    const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;
    const warpConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpConfigPath,
    );

    // Update the existing warp route config
    warpConfig.anvil2.owner = E2E_TEST_BURN_ADDRESS;

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
      warpConfig,
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

      const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
        WARP_CONFIG_PATH_EXAMPLE,
      );

      // Add the first address as rebalancer and then remove it and add the second one
      const allowedRebalancerBridges = [randomAddress(), randomAddress()].map(
        normalizeAddressEvm,
      );

      for (const rebalancer of allowedRebalancerBridges) {
        const anvil2Config: WarpRouteDeployConfig = {
          anvil2: HypTokenRouterConfigMailboxOptionalSchema.parse({
            ...warpConfig.anvil1,
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
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // First read the existing config
    const warpDeployConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
    );

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
    await writeYamlOrJson(warpDeployPath, warpDeployConfig);

    await hyperlaneWarpApply(warpDeployPath, WARP_CORE_CONFIG_PATH_2);
    const updatedConfig = await readWarpConfig(
      CHAIN_NAME_2,
      WARP_CORE_CONFIG_PATH_2,
      warpDeployPath,
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

  it('should update the Everclear fee params and output asset addresses', async () => {
    const COMBINED_WARP_CORE_CONFIG_PATH =
      GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
        WARP_DEPLOY_OUTPUT_PATH,
        await tokenChain2.symbol(),
      );

    const everclearTokenConfig: Extract<
      WarpRouteDeployConfig[string],
      { type: typeof TokenType.collateralEverclear }
    > = {
      type: TokenType.collateralEverclear,
      token: tokenChain2.address,
      owner: ownerAddress,
      everclearBridgeAddress: everclearBridgeAdapterMock.address,
      everclearFeeParams: {
        [CHAIN_NAME_3]: {
          deadline: Date.now(),
          fee: 1000,
          signature: '0x42',
        },
      },
      outputAssets: {
        [CHAIN_NAME_3]: randomAddress(),
      },
    };

    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: everclearTokenConfig,
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const expectedOutputAssetAddress = randomAddress();
    const expectedFeeSettings: EverclearCollateralTokenConfig['everclearFeeParams'][number] =
      {
        deadline: Date.now(),
        fee: randomInt(100),
        signature: '0x42',
      };

    everclearTokenConfig.everclearFeeParams = {
      [CHAIN_NAME_3]: expectedFeeSettings,
    };
    everclearTokenConfig.outputAssets = {
      [CHAIN_NAME_3]: expectedOutputAssetAddress,
    };

    warpConfig[CHAIN_NAME_2] = everclearTokenConfig;

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpApply(
      WARP_DEPLOY_OUTPUT_PATH,
      COMBINED_WARP_CORE_CONFIG_PATH,
    );

    const coreConfig: WarpCoreConfig = readYamlOrJson(
      COMBINED_WARP_CORE_CONFIG_PATH,
    );

    const [chain2TokenConfig] = coreConfig.tokens.filter(
      (config) => config.chainName === CHAIN_NAME_2,
    );
    expect(chain2TokenConfig).to.exist;

    const movableToken = EverclearTokenBridge__factory.connect(
      chain2TokenConfig.addressOrDenom!,
      providerChain2,
    );

    const onChainEverclearBridgeAdapterAddress =
      await movableToken.everclearAdapter();
    expect(onChainEverclearBridgeAdapterAddress).to.equal(
      everclearBridgeAdapterMock.address,
    );

    const [fee, deadline, signature] =
      await movableToken.feeParams(chain3DomainId);
    expect(deadline.toNumber()).to.equal(expectedFeeSettings.deadline);
    expect(fee.toNumber()).to.equal(expectedFeeSettings.fee);
    expect(signature).to.equal(expectedFeeSettings.signature);

    const outputAssetAddress = await movableToken.outputAssets(chain3DomainId);
    expect(outputAssetAddress).to.equal(
      addressToBytes32(expectedOutputAssetAddress),
    );
  });
});
