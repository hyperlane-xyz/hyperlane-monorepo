import { JsonRpcProvider } from '@ethersproject/providers';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet, ethers } from 'ethers';

import {
  ERC20Test__factory,
  MockPredicateRegistry__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  type CollateralTokenConfig,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { hyperlaneWarpDeploy, readWarpConfig } from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

describe('hyperlane warp deploy with Predicate e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Metadata: ChainMetadata;
  let chain3Metadata: ChainMetadata;
  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let walletChain2: Wallet;
  let providerChain2: JsonRpcProvider;
  let providerChain3: JsonRpcProvider;

  let testTokenAddress: Address;
  let mockPredicateRegistryAddress: Address;

  const MOCK_POLICY_ID = 'x-test-policy-predicate-e2e';

  before(async function () {
    chain2Metadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    chain3Metadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);
    walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    ownerAddress = walletChain2.address;

    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    const testToken = await new ERC20Test__factory(walletChain2).deploy(
      'Test Token',
      'TEST',
      '1000000000000000000000000',
      18,
    );
    await testToken.deployed();
    testTokenAddress = testToken.address;

    const mockRegistry = await new MockPredicateRegistry__factory(
      walletChain2,
    ).deploy();
    await mockRegistry.deployed();
    mockPredicateRegistryAddress = mockRegistry.address;
  });

  describe('collateral token with Predicate wrapper', () => {
    const warpDeployPath = `${TEMP_PATH}/warp-deploy-predicate-collateral.yaml`;
    const warpCoreConfigPath = getCombinedWarpRoutePath('PRED', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    it('should deploy collateral warp route with Predicate wrapper', async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: testTokenAddress,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          predicateWrapper: {
            predicateRegistry: mockPredicateRegistryAddress,
            policyId: MOCK_POLICY_ID,
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(warpDeployPath, warpConfig);

      await hyperlaneWarpDeploy(warpDeployPath, 'PRED/anvil2-anvil3');

      const deployedConfig = await readWarpConfig(
        CHAIN_NAME_2,
        warpCoreConfigPath,
        WARP_DEPLOY_OUTPUT_PATH,
      );

      expect(deployedConfig[CHAIN_NAME_2].type).to.equal(TokenType.collateral);
      const collateralConfig = deployedConfig[
        CHAIN_NAME_2
      ] as CollateralTokenConfig;
      expect(collateralConfig.token).to.equal(testTokenAddress);

      const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCoreConfigPath);
      const chain2Token = warpCoreConfig.tokens.find(
        (t) => t.chainName === CHAIN_NAME_2,
      );
      expect(chain2Token).to.exist;
      expect(chain2Token!.addressOrDenom).to.exist;
      expect(ethers.utils.isAddress(chain2Token!.addressOrDenom!)).to.be.true;

      const router = TokenRouter__factory.connect(
        chain2Token!.addressOrDenom!,
        walletChain2,
      );
      const hookAddress = await router.hook();
      expect(hookAddress).to.not.equal(
        '0x0000000000000000000000000000000000000000',
      );
    });
  });

  describe('synthetic token with Predicate wrapper', () => {
    const warpDeployPath = `${TEMP_PATH}/warp-deploy-predicate-synthetic.yaml`;
    const warpCoreConfigPath = getCombinedWarpRoutePath('PREDSYN', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    let mockPredicateRegistryChain3: Address;

    before(async function () {
      const walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);
      const mockRegistry = await new MockPredicateRegistry__factory(
        walletChain3,
      ).deploy();
      await mockRegistry.deployed();
      mockPredicateRegistryChain3 = mockRegistry.address;
    });

    it('should deploy synthetic warp route with Predicate wrapper', async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: testTokenAddress,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
          predicateWrapper: {
            predicateRegistry: mockPredicateRegistryChain3,
            policyId: MOCK_POLICY_ID,
          },
        },
      };

      writeYamlOrJson(warpDeployPath, warpConfig);

      await hyperlaneWarpDeploy(warpDeployPath, 'PREDSYN/anvil2-anvil3');

      const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCoreConfigPath);
      const chain3Token = warpCoreConfig.tokens.find(
        (t) => t.chainName === CHAIN_NAME_3,
      );
      expect(chain3Token).to.exist;
      expect(chain3Token!.addressOrDenom).to.exist;
      expect(ethers.utils.isAddress(chain3Token!.addressOrDenom!)).to.be.true;

      const walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);
      const router = TokenRouter__factory.connect(
        chain3Token!.addressOrDenom!,
        walletChain3,
      );
      const hookAddress = await router.hook();
      expect(hookAddress).to.not.equal(
        '0x0000000000000000000000000000000000000000',
      );
    });
  });

  describe('native token with Predicate wrapper', () => {
    const warpDeployPath = `${TEMP_PATH}/warp-deploy-predicate-native.yaml`;
    const warpCoreConfigPath = getCombinedWarpRoutePath('PREDNATIVE', [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    it('should deploy native warp route with Predicate wrapper', async function () {
      const warpConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.native,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          predicateWrapper: {
            predicateRegistry: mockPredicateRegistryAddress,
            policyId: MOCK_POLICY_ID,
          },
        } as any,
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
        },
      };

      writeYamlOrJson(warpDeployPath, warpConfig);

      await hyperlaneWarpDeploy(warpDeployPath, 'PREDNATIVE/anvil2-anvil3');

      const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCoreConfigPath);
      const chain2Token = warpCoreConfig.tokens.find(
        (t) => t.chainName === CHAIN_NAME_2,
      );
      expect(chain2Token).to.exist;
      expect(chain2Token!.addressOrDenom).to.exist;
      expect(ethers.utils.isAddress(chain2Token!.addressOrDenom!)).to.be.true;

      const router = TokenRouter__factory.connect(
        chain2Token!.addressOrDenom!,
        walletChain2,
      );
      const hookAddress = await router.hook();
      expect(hookAddress).to.not.equal(
        '0x0000000000000000000000000000000000000000',
      );
    });
  });
});
