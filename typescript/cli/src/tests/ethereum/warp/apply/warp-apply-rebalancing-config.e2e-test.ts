import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';

import {
  ERC20Test,
  EverclearTokenBridge__factory,
  MockEverclearAdapter,
} from '@hyperlane-xyz/core';
import {
  EverclearCollateralTokenConfig,
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
  randomInt,
} from '@hyperlane-xyz/utils';

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
import {
  deployEverclearBridgeAdapter,
  deployToken,
} from '../../commands/helpers.js';
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

  const chain3Metadata = TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3;
  const chain3DomainId: number = chain3Metadata.domainId;

  let tokenChain2: ERC20Test;
  let everclearBridgeAdapterMock: MockEverclearAdapter;

  let providerChain2: JsonRpcProvider;

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
    const chain2Metadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrl);

    tokenChain2 = await deployToken(
      HYP_KEY_BY_PROTOCOL.ethereum,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      undefined,
      undefined,
      undefined,
      REGISTRY_PATH,
    );
    everclearBridgeAdapterMock = await deployEverclearBridgeAdapter(
      HYP_KEY_BY_PROTOCOL.ethereum,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      REGISTRY_PATH,
    );

    await Promise.all([
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

  it('should add a new rebalancer and remove an existing one', async () => {
    // Add the first address as rebalancer and then remove it and add the second one
    const allowedRebalancers = [randomAddress(), randomAddress()].map(
      normalizeAddressEvm,
    );

    for (const rebalancer of allowedRebalancers) {
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2] = {
        ...warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2],
        type: TokenType.native,
        allowedRebalancers: [rebalancer],
      };

      writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

      await evmWarpCommands.applyRaw({
        warpRouteId: DEFAULT_EVM_WARP_ID,
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
        updatedWarpDeployConfig.anvil2.allowedRebalancers?.length,
      ).to.equal(1);

      const [currentRebalancer] =
        updatedWarpDeployConfig.anvil2.allowedRebalancers ?? [];
      expect(currentRebalancer).to.equal(rebalancer);
    }
  });

  const addAndRemoveBridgeTestCases = () => {
    const chain3Metadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3;

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
      // Add the first address as rebalancer and then remove it and add the second one
      const allowedRebalancerBridges = [randomAddress(), randomAddress()].map(
        normalizeAddressEvm,
      );

      for (const rebalancer of allowedRebalancerBridges) {
        const warpDeployConfig = fixture.getDeployConfig();
        const updatedConfig = {
          anvil2: HypTokenRouterConfigMailboxOptionalSchema.parse({
            ...warpDeployConfig[
              TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
            ],
            owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
            remoteRouters: {
              [chain3DomainId]: { address: randomAddress() },
            },
            allowedRebalancingBridges: {
              [domainIdOrChainName]: [{ bridge: rebalancer }],
            },
          }),
        };
        writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, updatedConfig);
        await evmWarpCommands.applyRaw({
          warpRouteId: DEFAULT_EVM_WARP_ID,
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

  it('should update the Everclear fee params and output asset addresses', async () => {
    const everclearTokenConfig: Extract<
      WarpRouteDeployConfig[string],
      { type: typeof TokenType.collateralEverclear }
    > = {
      type: TokenType.collateralEverclear,
      token: tokenChain2.address,
      owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      everclearBridgeAddress: everclearBridgeAdapterMock.address,
      everclearFeeParams: {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          deadline: Date.now(),
          fee: 1000,
          signature: '0x42',
        },
      },
      outputAssets: {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: randomAddress(),
      },
    };

    const warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]:
        everclearTokenConfig,
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
    };

    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);
    await evmWarpCommands.deploy(
      DEFAULT_EVM_WARP_DEPLOY_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    const expectedOutputAssetAddress = randomAddress();
    const expectedFeeSettings: EverclearCollateralTokenConfig['everclearFeeParams'][number] =
      {
        deadline: Date.now(),
        fee: randomInt(100),
        signature: '0x42',
      };

    everclearTokenConfig.everclearFeeParams = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: expectedFeeSettings,
    };
    everclearTokenConfig.outputAssets = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]:
        expectedOutputAssetAddress,
    };

    const updatedWarpDeployConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]:
        everclearTokenConfig,
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
    };

    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, updatedWarpDeployConfig);
    await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const coreConfig: WarpCoreConfig = readYamlOrJson(
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    const [chain2TokenConfig] = coreConfig.tokens.filter(
      (config) =>
        config.chainName === TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
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
