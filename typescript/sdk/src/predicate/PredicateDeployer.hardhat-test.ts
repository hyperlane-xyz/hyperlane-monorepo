import { expect } from 'chai';
import { Signer, constants } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test__factory,
  HypERC20Collateral,
  HypERC20Collateral__factory,
  MockPredicateRegistry,
  MockPredicateRegistry__factory,
  PredicateRouterWrapper__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { HyperlaneContracts } from '../contracts/types.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmHypCollateralAdapter } from '../token/adapters/EvmTokenAdapter.js';

import { PredicateWrapperDeployer } from './PredicateDeployer.js';

describe('PredicateWrapperDeployer', async () => {
  const chain = TestChainName.test1;
  const MOCK_POLICY_ID = 'x-test-policy-123';

  let multiProvider: MultiProvider;
  let signer: Signer;
  let signerAddress: Address;
  let factoryContracts: HyperlaneContracts<ProxyFactoryFactories>;
  let mailboxAddress: Address;
  let testTokenAddress: Address;
  let warpRouteAddress: Address;
  let mockPredicateRegistry: MockPredicateRegistry;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    signerAddress = await signer.getAddress();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const factoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const contractsMap = await factoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );

    factoryContracts = contractsMap[chain];

    const legacyIsmFactory = new HyperlaneIsmFactory(
      contractsMap,
      multiProvider,
    );

    const testCoreDeployer = new TestCoreDeployer(
      multiProvider,
      legacyIsmFactory,
    );

    const { mailbox } = (await testCoreDeployer.deployApp()).getContracts(
      chain,
    );
    mailboxAddress = mailbox.address;

    const testToken = await new ERC20Test__factory(signer).deploy(
      'Test Token',
      'TEST',
      '1000000000000000000000000',
      18,
    );
    await testToken.deployed();
    testTokenAddress = testToken.address;

    mockPredicateRegistry = await new MockPredicateRegistry__factory(
      signer,
    ).deploy();
    await mockPredicateRegistry.deployed();

    const collateral = await new HypERC20Collateral__factory(signer).deploy(
      testTokenAddress,
      1,
      mailboxAddress,
    );
    await collateral.deployed();

    await collateral.initialize(
      constants.AddressZero,
      constants.AddressZero,
      signerAddress,
    );
    warpRouteAddress = collateral.address;
  });

  describe('deployPredicateWrapper', () => {
    it('should deploy PredicateRouterWrapper contract', async () => {
      const deployer = new PredicateWrapperDeployer(
        multiProvider,
        factoryContracts.staticAggregationHookFactory,
      );

      const wrapperAddress = await deployer.deployPredicateWrapper(
        chain,
        warpRouteAddress,
        {
          predicateRegistry: mockPredicateRegistry.address,
          policyId: MOCK_POLICY_ID,
        },
      );

      expect(wrapperAddress).to.be.properAddress;

      const code = await multiProvider
        .getProvider(chain)
        .getCode(wrapperAddress);
      expect(code).to.not.equal('0x');
    });
  });

  describe('createAggregationHook', () => {
    it('should create aggregation hook with two hooks', async () => {
      const deployer = new PredicateWrapperDeployer(
        multiProvider,
        factoryContracts.staticAggregationHookFactory,
      );

      const wrapperAddress = await deployer.deployPredicateWrapper(
        chain,
        warpRouteAddress,
        {
          predicateRegistry: mockPredicateRegistry.address,
          policyId: MOCK_POLICY_ID,
        },
      );

      const existingHookAddress = '0x1234567890123456789012345678901234567890';

      const aggregationHookAddress = await deployer.createAggregationHook(
        chain,
        wrapperAddress,
        existingHookAddress,
      );

      expect(aggregationHookAddress).to.be.properAddress;

      const code = await multiProvider
        .getProvider(chain)
        .getCode(aggregationHookAddress);
      expect(code).to.not.equal('0x');
    });
  });

  describe('deployAndConfigure', () => {
    it('should deploy wrapper and aggregate with mailbox default hook when no existing hook', async () => {
      const newCollateral = await new HypERC20Collateral__factory(
        signer,
      ).deploy(testTokenAddress, 1, mailboxAddress);
      await newCollateral.deployed();
      await newCollateral.initialize(
        constants.AddressZero,
        constants.AddressZero,
        signerAddress,
      );

      const deployer = new PredicateWrapperDeployer(
        multiProvider,
        factoryContracts.staticAggregationHookFactory,
      );

      const result = await deployer.deployAndConfigure(
        chain,
        newCollateral.address,
        {
          predicateRegistry: mockPredicateRegistry.address,
          policyId: MOCK_POLICY_ID,
        },
      );

      expect(result.wrapperAddress).to.be.properAddress;
      expect(result.aggregationHookAddress).to.be.properAddress;

      // Even with no existing hook, we aggregate with mailbox default hook for gas quoting
      expect(result.wrapperAddress).to.not.equal(result.aggregationHookAddress);

      const router = TokenRouter__factory.connect(
        newCollateral.address,
        signer,
      );
      const hookOnRouter = await router.hook();
      expect(hookOnRouter).to.equal(result.aggregationHookAddress);
    });

    it('should create aggregation hook when existing hook is present', async () => {
      const existingHook = await new ERC20Test__factory(signer).deploy(
        'Dummy Hook',
        'DH',
        '0',
        18,
      );
      await existingHook.deployed();

      const newCollateral = await new HypERC20Collateral__factory(
        signer,
      ).deploy(testTokenAddress, 1, mailboxAddress);
      await newCollateral.deployed();
      await newCollateral.initialize(
        existingHook.address,
        constants.AddressZero,
        signerAddress,
      );

      const deployer = new PredicateWrapperDeployer(
        multiProvider,
        factoryContracts.staticAggregationHookFactory,
      );

      const result = await deployer.deployAndConfigure(
        chain,
        newCollateral.address,
        {
          predicateRegistry: mockPredicateRegistry.address,
          policyId: MOCK_POLICY_ID,
        },
      );

      expect(result.wrapperAddress).to.not.equal(result.aggregationHookAddress);

      const router = TokenRouter__factory.connect(
        newCollateral.address,
        signer,
      );
      const hookOnRouter = await router.hook();
      expect(hookOnRouter).to.equal(result.aggregationHookAddress);
    });
  });

  describe('Adapter Predicate Support', () => {
    let wrapperAddress: Address;
    let collateralWithWrapper: HypERC20Collateral;
    let multiProtocolProvider: MultiProtocolProvider;

    before(async () => {
      multiProtocolProvider =
        MultiProtocolProvider.fromMultiProvider(multiProvider);

      collateralWithWrapper = await new HypERC20Collateral__factory(
        signer,
      ).deploy(testTokenAddress, 1, mailboxAddress);
      await collateralWithWrapper.deployed();
      await collateralWithWrapper.initialize(
        constants.AddressZero,
        constants.AddressZero,
        signerAddress,
      );

      const deployer = new PredicateWrapperDeployer(
        multiProvider,
        factoryContracts.staticAggregationHookFactory,
      );
      const result = await deployer.deployAndConfigure(
        chain,
        collateralWithWrapper.address,
        {
          predicateRegistry: mockPredicateRegistry.address,
          policyId: MOCK_POLICY_ID,
        },
      );
      wrapperAddress = result.wrapperAddress;
    });

    it('should detect PredicateRouterWrapper on collateral adapter', async () => {
      const adapter = new EvmHypCollateralAdapter(
        chain,
        multiProtocolProvider,
        {
          token: collateralWithWrapper.address,
        },
      );

      const detectedWrapper = await (
        adapter as any
      ).getPredicateWrapperAddress();
      expect(detectedWrapper).to.equal(wrapperAddress);
    });

    it('should return null when no PredicateRouterWrapper present', async () => {
      const adapter = new EvmHypCollateralAdapter(
        chain,
        multiProtocolProvider,
        {
          token: warpRouteAddress,
        },
      );

      const detectedWrapper = await (
        adapter as any
      ).getPredicateWrapperAddress();
      expect(detectedWrapper).to.be.null;
    });

    it('should route approval to wrapper when wrapper present', async () => {
      const adapter = new EvmHypCollateralAdapter(
        chain,
        multiProtocolProvider,
        {
          token: collateralWithWrapper.address,
        },
      );

      const approveTx = await adapter.populateApproveTx({
        weiAmountOrId: '1000000',
        recipient: collateralWithWrapper.address,
      });

      expect(approveTx.to?.toLowerCase()).to.equal(
        testTokenAddress.toLowerCase(),
      );
      expect(approveTx.data).to.include(wrapperAddress.slice(2).toLowerCase());
    });

    it('should throw error when attestation provided but no wrapper', async () => {
      const adapter = new EvmHypCollateralAdapter(
        chain,
        multiProtocolProvider,
        {
          token: warpRouteAddress,
        },
      );

      const mockAttestation = {
        uuid: 'test-uuid',
        expiration: Math.floor(Date.now() / 1000) + 3600,
        attester: signerAddress,
        signature: '0x1234',
      };

      try {
        await adapter.populateTransferRemoteTx({
          weiAmountOrId: '1000000',
          destination: 2,
          recipient: signerAddress,
          attestation: mockAttestation,
        });
        expect.fail('Expected error to be thrown');
      } catch (error: any) {
        expect(error.message).to.include(
          'Attestation provided but no PredicateRouterWrapper detected',
        );
      }
    });

    it('should populate transferRemoteWithAttestation when attestation provided', async () => {
      const adapter = new EvmHypCollateralAdapter(
        chain,
        multiProtocolProvider,
        {
          token: collateralWithWrapper.address,
        },
      );

      const mockAttestation = {
        uuid: 'test-uuid',
        expiration: Math.floor(Date.now() / 1000) + 3600,
        attester: signerAddress,
        signature: '0x1234',
      };

      const tx = await adapter.populateTransferRemoteTx({
        weiAmountOrId: '1000000',
        destination: 2,
        recipient: signerAddress,
        attestation: mockAttestation,
        interchainGas: {
          igpQuote: { amount: 0n },
        },
      });

      expect(tx.to?.toLowerCase()).to.equal(wrapperAddress.toLowerCase());
      const iface = PredicateRouterWrapper__factory.createInterface();
      const selector = iface.getSighash('transferRemoteWithAttestation');
      expect(tx.data?.startsWith(selector)).to.be.true;
    });
  });
});
