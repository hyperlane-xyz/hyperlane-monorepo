import { JsonRpcProvider } from '@ethersproject/providers';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';

import {
  ERC20Test,
  EverclearTokenBridge__factory,
  MockEverclearAdapter,
  MovableCollateralRouter__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMetadata,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigSchema,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  addressToBytes32,
  assert,
  normalizeAddressEvm,
  objMap,
  pick,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH,
  deployEverclearBridgeAdapter,
  deployToken,
} from '../commands/helpers.js';
import { hyperlaneWarpDeploy, readWarpConfig } from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_4_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../consts.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

function extractInputOnlyFields(config: TokenFeeConfigInput): any {
  if (!config) return config;

  switch (config.type) {
    case TokenFeeType.LinearFee:
      return {
        type: config.type,
        bps: config.bps.toString(), // Convert to string for consistent comparison
      };
    case TokenFeeType.RoutingFee:
      return {
        type: config.type,
        ...(config.feeContracts && {
          feeContracts: objMap(config.feeContracts, (_, subConfig) =>
            extractInputOnlyFields(subConfig),
          ),
        }),
      };
    case TokenFeeType.ProgressiveFee:
    case TokenFeeType.RegressiveFee:
      return pick(config, ['type', 'maxFee', 'halfAmount']);
    default:
      return config;
  }
}

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(1.5 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Metadata: ChainMetadata;
  let chain3DomainId: number;
  let chain4DomainId: number;

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let providerChain2: JsonRpcProvider;

  before(async function () {
    chain2Metadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    ownerAddress = walletChain2.address;

    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    chain3DomainId = chain3Metadata.domainId;

    const chain4Metadata: ChainMetadata = readYamlOrJson(CHAIN_4_METADATA_PATH);
    chain4DomainId = chain4Metadata.domainId;

    // Deploy core contracts to populate the registry
    await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
  });

  describe(`hyperlane warp deploy --config ... --yes --key ...`, () => {
    let tokenChain2: ERC20Test;
    let everclearBridgeAdapterMock: MockEverclearAdapter;

    before(async () => {
      tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
      everclearBridgeAdapterMock = await deployEverclearBridgeAdapter(
        ANVIL_KEY,
        CHAIN_NAME_2,
        REGISTRY_PATH,
      );
    });

    const MAX_UINT256 =
      115792089237316195423570985008687907853269984665640564039457584007913129639935n;

    it('should set the allowed bridges and the related token approvals', async function () {
      const bridges = [randomAddress(), randomAddress()];
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: tokenChain2.address,
          owner: ownerAddress,
          allowedRebalancingBridges: {
            [chain3DomainId]: bridges.map((bridge) => ({
              bridge,
              approvedTokens: [tokenChain2.address],
            })),
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          await tokenChain2.symbol(),
        );

      const coreConfig: WarpCoreConfig = readYamlOrJson(
        COMBINED_WARP_CORE_CONFIG_PATH,
      );

      const [chain2TokenConfig] = coreConfig.tokens.filter(
        (config) => config.chainName === CHAIN_NAME_2,
      );
      expect(chain2TokenConfig).to.exist;

      const movableToken = MovableCollateralRouter__factory.connect(
        chain2TokenConfig.addressOrDenom!,
        providerChain2,
      );

      for (const bridge of bridges) {
        const allowance = await tokenChain2.callStatic.allowance(
          chain2TokenConfig.addressOrDenom!,
          bridge,
        );
        expect(allowance.toBigInt() === MAX_UINT256).to.be.true;

        const allowedBridgesOnDomain =
          await movableToken.callStatic.allowedBridges(chain3DomainId);
        expect(allowedBridgesOnDomain.length).to.eql(bridges.length);
        expect(
          new Set(allowedBridgesOnDomain.map(normalizeAddressEvm)).has(
            normalizeAddressEvm(bridge),
          ),
        );
      }
    });

    it('should allow setting the same bridge on different domains', async function () {
      const allowedBridge = randomAddress();
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: tokenChain2.address,
          owner: ownerAddress,
          allowedRebalancingBridges: {
            [chain3DomainId]: [
              {
                bridge: allowedBridge,
                approvedTokens: [tokenChain2.address],
              },
            ],
            [chain4DomainId]: [
              {
                bridge: allowedBridge,
                approvedTokens: [tokenChain2.address],
              },
            ],
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
        [CHAIN_NAME_4]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          await tokenChain2.symbol(),
        );

      const coreConfig: WarpCoreConfig = readYamlOrJson(
        COMBINED_WARP_CORE_CONFIG_PATH,
      );

      const [chain2TokenConfig] = coreConfig.tokens.filter(
        (config) => config.chainName === CHAIN_NAME_2,
      );
      expect(chain2TokenConfig).to.exist;

      const movableToken = MovableCollateralRouter__factory.connect(
        chain2TokenConfig.addressOrDenom!,
        providerChain2,
      );

      for (const domain of [chain3DomainId, chain4DomainId]) {
        const allowance = await tokenChain2.callStatic.allowance(
          chain2TokenConfig.addressOrDenom!,
          allowedBridge,
        );
        expect(allowance.toBigInt() === MAX_UINT256).to.be.true;

        const allowedBridgesOnDomain =
          await movableToken.callStatic.allowedBridges(domain);
        expect(allowedBridgesOnDomain.length).to.eql(1);
        expect(
          new Set(allowedBridgesOnDomain.map(normalizeAddressEvm)).has(
            normalizeAddressEvm(allowedBridge),
          ),
        );
      }
    });

    it('should deploy a token fee with top-level owner when fee owner is unspecified', async () => {
      const tokenFee = {
        type: TokenFeeType.LinearFee,
        token: tokenChain2.address,
        bps: 1n,
      };

      const warpConfig = WarpRouteDeployConfigSchema.parse({
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: tokenChain2.address,
          owner: ownerAddress,
          tokenFee,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
      });
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          await tokenChain2.symbol(),
        );

      const collateralConfig = (
        await readWarpConfig(
          CHAIN_NAME_2,
          COMBINED_WARP_CORE_CONFIG_PATH,
          WARP_DEPLOY_OUTPUT_PATH,
        )
      )[CHAIN_NAME_2];
      expect(collateralConfig.tokenFee?.owner).to.equal(ownerAddress);
    });

    it('should deploy a token fee with top-level token when fee token is unspecified', async () => {
      const tokenFee = {
        type: TokenFeeType.LinearFee,
        owner: ownerAddress,
        bps: 1n,
      };

      const warpConfig = WarpRouteDeployConfigSchema.parse({
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: tokenChain2.address,
          owner: ownerAddress,
          tokenFee,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
      });

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          await tokenChain2.symbol(),
        );

      const collateralConfig = (
        await readWarpConfig(
          CHAIN_NAME_2,
          COMBINED_WARP_CORE_CONFIG_PATH,
          WARP_DEPLOY_OUTPUT_PATH,
        )
      )[CHAIN_NAME_2];

      expect(collateralConfig.tokenFee?.token).to.equal(tokenChain2.address);
    });

    for (const tokenFee of [
      {
        type: TokenFeeType.RoutingFee,
        feeContracts: {
          [CHAIN_NAME_3]: {
            type: TokenFeeType.LinearFee,
            bps: 50,
          },
        },
      },
      {
        type: TokenFeeType.LinearFee,
        bps: 1,
      },
    ]) {
      it(`should deploy ${tokenFee.type} tokenFee`, async () => {
        const warpConfig = WarpRouteDeployConfigSchema.parse({
          [CHAIN_NAME_2]: {
            type: TokenType.collateral,
            token: tokenChain2.address,
            owner: ownerAddress,
            tokenFee,
          },
          [CHAIN_NAME_3]: {
            type: TokenType.synthetic,
            owner: ownerAddress,
          },
        });

        writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
        await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

        const COMBINED_WARP_CORE_CONFIG_PATH =
          GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
            WARP_DEPLOY_OUTPUT_PATH,
            await tokenChain2.symbol(),
          );

        const collateralConfig: WarpRouteDeployConfigMailboxRequired =
          await readWarpConfig(
            CHAIN_NAME_2,
            COMBINED_WARP_CORE_CONFIG_PATH,
            WARP_DEPLOY_OUTPUT_PATH,
          );

        expect(
          extractInputOnlyFields(collateralConfig[CHAIN_NAME_2].tokenFee!),
        ).to.deep.equal(
          extractInputOnlyFields(warpConfig[CHAIN_NAME_2].tokenFee!),
        );
      });
    }

    it(`should deploy a native Routing Fee when providing maxFee and halfAmount only`, async () => {
      const warpConfig = WarpRouteDeployConfigSchema.parse({
        [CHAIN_NAME_2]: {
          type: TokenType.native,
          owner: ownerAddress,
          tokenFee: {
            type: TokenFeeType.RoutingFee,
            feeContracts: {
              [CHAIN_NAME_3]: {
                type: TokenFeeType.LinearFee,
                maxFee: 10_000,
                halfAmount: 5_000,
              },
            },
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
      });

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      assert(
        chain2Metadata.nativeToken?.symbol,
        'Must have native token symbol',
      );
      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          chain2Metadata.nativeToken?.symbol,
        );

      const collateralConfig: WarpRouteDeployConfigMailboxRequired =
        await readWarpConfig(
          CHAIN_NAME_2,
          COMBINED_WARP_CORE_CONFIG_PATH,
          WARP_DEPLOY_OUTPUT_PATH,
        );

      expect(
        extractInputOnlyFields(collateralConfig[CHAIN_NAME_2].tokenFee!),
      ).to.deep.equal(
        extractInputOnlyFields(warpConfig[CHAIN_NAME_2].tokenFee!),
      );
    });

    it('should set the Everclear fee params and output asset addresses', async () => {
      const expectedFeeSettings = {
        deadline: Date.now(),
        fee: 1000,
        signature: '0x42',
      };

      const expectedOutputAssetAddress = randomAddress();
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateralEverclear,
          token: tokenChain2.address,
          owner: ownerAddress,
          everclearBridgeAddress: everclearBridgeAdapterMock.address,
          everclearFeeParams: {
            [CHAIN_NAME_3]: expectedFeeSettings,
          },
          outputAssets: {
            [CHAIN_NAME_3]: expectedOutputAssetAddress,
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const COMBINED_WARP_CORE_CONFIG_PATH =
        GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH(
          WARP_DEPLOY_OUTPUT_PATH,
          await tokenChain2.symbol(),
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

      const outputAssetAddress =
        await movableToken.outputAssets(chain3DomainId);
      expect(outputAssetAddress).to.equal(
        addressToBytes32(expectedOutputAssetAddress),
      );
    });
  });
});
