import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';
import sinon from 'sinon';

import {
  CrossCollateralRoutingFee__factory,
  ERC20Test,
  ERC20Test__factory,
} from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeModule } from './EvmTokenFeeModule.js';
import { BPS, HALF_AMOUNT, MAX_FEE } from './EvmTokenFeeReader.hardhat-test.js';
import { TokenFeeReaderParams } from './EvmTokenFeeReader.js';
import {
  CrossCollateralRoutingFeeConfigSchema,
  DEFAULT_ROUTER_KEY,
  LinearFeeConfig,
  OffchainQuotedLinearFeeConfig,
  ResolvedCrossCollateralRoutingFeeConfigInput,
  ResolvedTokenFeeConfigInput,
  RoutingFeeConfig,
  TokenFeeConfig,
  TokenFeeConfigSchema,
  TokenFeeType,
} from './types.js';
import { convertToBps } from './utils.js';

describe('EvmTokenFeeModule', () => {
  const test4Chain = TestChainName.test4;
  let multiProvider: MultiProvider;
  let signer: SignerWithAddress;
  let token: ERC20Test;
  let config: LinearFeeConfig;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const factory = new ERC20Test__factory(signer);
    token = await factory.deploy('fake', 'FAKE', '100000000000000000000', 18);
    await token.deployed();

    config = {
      type: TokenFeeType.LinearFee,
      owner: signer.address,
      token: token.address,
      maxFee: MAX_FEE,
      halfAmount: HALF_AMOUNT,
      bps: BPS,
    };
  });

  async function deployCrossCollateralRoutingFee(owner: string) {
    const factory = new CrossCollateralRoutingFee__factory(signer);
    const ccrf = await factory.deploy(owner);
    await ccrf.deployed();
    return ccrf;
  }

  async function expectTxsAndUpdate(
    feeModule: EvmTokenFeeModule,
    config: TokenFeeConfig,
    n: number,
    params?: Partial<TokenFeeReaderParams>,
  ) {
    const txs = await feeModule.update(config, params);
    expect(txs.length).to.equal(n);

    for (const tx of txs) {
      await multiProvider.sendTransaction(test4Chain, tx);
    }
  }

  it('should create a new token fee', async () => {
    const module = await EvmTokenFeeModule.create({
      multiProvider,
      chain: TestChainName.test2,
      config,
    });
    const onchainConfig = await module.read();
    expect(normalizeConfig(onchainConfig)).to.deep.equal(
      normalizeConfig({ ...config, maxFee: MAX_FEE, halfAmount: HALF_AMOUNT }),
    );
  });

  it('should create a new token fee with bps', async () => {
    const module = await EvmTokenFeeModule.create({
      multiProvider,
      chain: test4Chain,
      config,
    });
    const onchainConfig = await module.read();
    assert(
      onchainConfig.type === TokenFeeType.LinearFee,
      `Must be ${TokenFeeType.LinearFee}`,
    );
    assert(
      onchainConfig.type === TokenFeeType.LinearFee,
      `Must be ${TokenFeeType.LinearFee}`,
    );
    expect(onchainConfig.bps).to.equal(BPS);
  });

  it('should deploy and read the routing fee config', async () => {
    const routingFeeConfig: RoutingFeeConfig = {
      feeContracts: {
        [test4Chain]: config,
      },
      owner: signer.address,
      token: token.address,
      type: TokenFeeType.RoutingFee,
    };
    const module = await EvmTokenFeeModule.create({
      multiProvider,
      chain: test4Chain,
      config: routingFeeConfig,
    });
    const routingDestination = multiProvider.getDomainId(test4Chain);
    const onchainConfig = await module.read({
      routingDestinations: [routingDestination],
    });
    expect(normalizeConfig(onchainConfig)).to.deep.equal(
      normalizeConfig(routingFeeConfig),
    );
  });

  describe('Update', async () => {
    it('should not update if the linear configs are the same', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config,
      });

      const txs = await module.update(config);
      expect(txs).to.have.lengthOf(0);
    });

    it('should not update if the routing configs are the same', async () => {
      const routingConfig = TokenFeeConfigSchema.parse({
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: {
          [test4Chain]: config,
        },
      });
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: routingConfig,
      });
      const chainId = multiProvider.getDomainId(test4Chain);
      const txs = await module.update(routingConfig, {
        routingDestinations: [chainId],
      });
      expect(txs).to.have.lengthOf(0);
    });

    it('should not update if providing a bps that is the same as the result of calculating with maxFee and halfAmount', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config,
      });
      const updatedConfig: ResolvedTokenFeeConfigInput = {
        type: TokenFeeType.LinearFee,
        owner: config.owner,
        token: config.token,
        bps: BPS,
      };
      const txs = await module.update(updatedConfig);
      expect(txs).to.have.lengthOf(0);
    });

    it(`should redeploy immutable fees if updating token for ${TokenFeeType.LinearFee}`, async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config,
      });
      const updatedConfig = { ...config, bps: BPS + 1n };
      await expectTxsAndUpdate(module, updatedConfig, 0);
      const onchainConfig = await module.read();
      assert(
        onchainConfig.type === TokenFeeType.LinearFee,
        `Must be ${TokenFeeType.LinearFee}`,
      );
      expect(onchainConfig.bps).to.eql(updatedConfig.bps);
    });

    it(`should redeploy routing fees when nested fee config changes`, async () => {
      const feeContracts = {
        [test4Chain]: config,
      };
      const routingFeeConfig: TokenFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: feeContracts,
      };
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: routingFeeConfig,
      });
      const updatedConfig = {
        ...routingFeeConfig,
        feeContracts: {
          [test4Chain]: {
            ...feeContracts[test4Chain],
            bps: BPS + 1n,
          },
        },
      };

      // 1 tx: setFeeContract to point to redeployed sub-fee
      await expectTxsAndUpdate(module, updatedConfig, 1, {
        routingDestinations: [multiProvider.getDomainId(test4Chain)],
      });
      const onchainConfig = await module.read({
        routingDestinations: [multiProvider.getDomainId(test4Chain)],
      });
      assert(
        onchainConfig.type === TokenFeeType.RoutingFee,
        `Must be ${TokenFeeType.RoutingFee}`,
      );
      expect(onchainConfig.feeContracts[test4Chain]?.bps).to.equal(BPS + 1n);
    });

    it('should transfer ownership if they are different', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config,
      });
      await expectTxsAndUpdate(module, { ...config, owner: config.owner }, 0);
      const newOwner = randomAddress();
      await expectTxsAndUpdate(module, { ...config, owner: newOwner }, 1);
      const onchainConfig = await module.read();
      assert(
        onchainConfig.type === TokenFeeType.LinearFee,
        `Must be ${TokenFeeType.LinearFee}`,
      );
      expect(normalizeConfig(onchainConfig).owner).to.equal(
        normalizeConfig(newOwner),
      );
    });

    it('should redeploy routing fees when nested owner changes', async () => {
      const feeContracts = {
        [test4Chain]: config,
      };
      const routingFeeConfig: TokenFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: feeContracts,
      };
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: routingFeeConfig,
      });

      const newOwner = normalizeConfig(randomAddress());
      // 2 txs: sub-fee ownership transfer + routing fee ownership transfer
      await expectTxsAndUpdate(
        module,
        {
          ...routingFeeConfig,
          owner: newOwner,
          feeContracts: {
            [test4Chain]: { ...feeContracts[test4Chain], owner: newOwner },
          },
        },
        2,
        {
          routingDestinations: [multiProvider.getDomainId(test4Chain)],
        },
      );
      const onchainConfig = await module.read({
        routingDestinations: [multiProvider.getDomainId(test4Chain)],
      });
      assert(
        onchainConfig.type === TokenFeeType.RoutingFee,
        `Must be ${TokenFeeType.RoutingFee}`,
      );
      expect(normalizeConfig(onchainConfig).owner).to.equal(newOwner);
      expect(
        normalizeConfig(onchainConfig.feeContracts[test4Chain]).owner,
      ).to.equal(newOwner);
    });

    it('should derive routingDestinations from target config when not provided', async () => {
      const feeContracts = {
        [test4Chain]: config,
      };
      const routingFeeConfig: TokenFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts,
      };
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: routingFeeConfig,
      });

      // Update without providing routingDestinations - should derive from target config
      const updatedConfig = {
        ...routingFeeConfig,
        feeContracts: {
          [test4Chain]: {
            ...feeContracts[test4Chain],
            bps: BPS + 1n,
          },
        },
      };

      // 1 tx: setFeeContract to point to redeployed sub-fee
      const txs = await module.update(updatedConfig);
      expect(txs.length).to.equal(1);
      for (const tx of txs) {
        await multiProvider.sendTransaction(test4Chain, tx);
      }
      const onchainConfig = await module.read({
        routingDestinations: [multiProvider.getDomainId(test4Chain)],
      });
      assert(
        onchainConfig.type === TokenFeeType.RoutingFee,
        `Must be ${TokenFeeType.RoutingFee}`,
      );
      expect(onchainConfig.feeContracts[test4Chain]?.bps).to.equal(BPS + 1n);
    });

    it('should forward token reader params when updating routing fees', async () => {
      const routingConfig: RoutingFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: {
          [test4Chain]: config,
        },
      };
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: routingConfig,
      });
      const routingDestination = multiProvider.getDomainId(test4Chain);
      const actualConfig = await module.read({
        routingDestinations: [routingDestination],
      });
      const readStub = sinon.stub(module, 'read').resolves(actualConfig);

      try {
        const txs = await module.update(
          {
            type: TokenFeeType.RoutingFee,
            owner: signer.address,
            feeContracts: {
              [test4Chain]: {
                type: TokenFeeType.LinearFee,
                owner: signer.address,
                bps: BPS,
              },
            },
          },
          {
            routingDestinations: [routingDestination],
          },
        );

        expect(txs).to.have.lengthOf(0);
        expect(readStub.calledOnce).to.be.true;
        expect(readStub.firstCall.args[0]).to.deep.equal({
          routingDestinations: [routingDestination],
        });
      } finally {
        readStub.restore();
      }
    });

    it('should update CCRF owner when reader params are provided', async () => {
      const initialSubFeeModule = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config,
      });
      const ccrf = await deployCrossCollateralRoutingFee(signer.address);
      const routingDestination = multiProvider.getDomainId(test4Chain);
      await ccrf.setCrossCollateralRouterFeeContracts(
        [routingDestination],
        [await ccrf.DEFAULT_ROUTER()],
        [initialSubFeeModule.serialize().deployedFee],
      );

      const routingConfig: RoutingFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: {},
      };
      const module = new EvmTokenFeeModule(multiProvider, {
        chain: test4Chain,
        config: routingConfig,
        addresses: { deployedFee: ccrf.address },
      });

      const newOwner = randomAddress();
      const txs = await module.update(
        {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: newOwner,
          feeContracts: {
            [test4Chain]: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: signer.address,
                bps: BPS,
              },
            },
          },
        },
        {
          routingDestinations: [routingDestination],
          crossCollateralRouters: {
            [routingDestination]: [],
          },
        },
      );

      expect(txs).to.have.lengthOf(1);
      await multiProvider.sendTransaction(test4Chain, txs[0]);
      expect(await ccrf.owner()).to.equal(
        hre.ethers.utils.getAddress(newOwner),
      );
    });

    it('should redeploy CCRF when fee contracts differ', async () => {
      const initialSubFeeModule = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config,
      });
      const ccrf = await deployCrossCollateralRoutingFee(signer.address);

      const routingDestination = multiProvider.getDomainId(test4Chain);
      await ccrf.setCrossCollateralRouterFeeContracts(
        [routingDestination],
        [await ccrf.DEFAULT_ROUTER()],
        [initialSubFeeModule.serialize().deployedFee],
      );

      const routingConfig: RoutingFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: {},
      };
      const module = new EvmTokenFeeModule(multiProvider, {
        chain: test4Chain,
        config: routingConfig,
        addresses: { deployedFee: ccrf.address },
      });

      const txs = await module.update(
        {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: signer.address,
          feeContracts: {
            [test4Chain]: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: signer.address,
                bps: BPS + 1n,
              },
            },
          },
        },
        {
          routingDestinations: [routingDestination],
        },
      );

      expect(txs).to.have.lengthOf(0);
      expect(module.serialize().deployedFee).to.not.equal(ccrf.address);

      const onchainConfig = await module.read({
        routingDestinations: [routingDestination],
        crossCollateralRouters: {
          [routingDestination]: [],
        },
      });
      assert(
        onchainConfig.type === TokenFeeType.CrossCollateralRoutingFee,
        `Must be ${TokenFeeType.CrossCollateralRoutingFee}`,
      );
      assert(
        onchainConfig.feeContracts[test4Chain]?.[DEFAULT_ROUTER_KEY]?.type ===
          TokenFeeType.LinearFee,
        `Must be ${TokenFeeType.LinearFee}`,
      );
      expect(
        onchainConfig.feeContracts[test4Chain]?.[DEFAULT_ROUTER_KEY]?.bps,
      ).to.equal(BPS + 1n);
    });

    it('should redeploy an empty CCRF using explicitly resolved child tokens', async () => {
      const emptyCcrf = await deployCrossCollateralRoutingFee(signer.address);
      const routingDestination = multiProvider.getDomainId(test4Chain);
      const module = new EvmTokenFeeModule(multiProvider, {
        chain: test4Chain,
        config: CrossCollateralRoutingFeeConfigSchema.parse({
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: signer.address,
          feeContracts: {},
        }),
        addresses: { deployedFee: emptyCcrf.address },
      });

      const targetConfig: ResolvedCrossCollateralRoutingFeeConfigInput = {
        type: TokenFeeType.CrossCollateralRoutingFee,
        owner: signer.address,
        feeContracts: {
          [test4Chain]: {
            [DEFAULT_ROUTER_KEY]: {
              type: TokenFeeType.LinearFee,
              owner: signer.address,
              token: token.address,
              bps: BPS,
            },
          },
        },
      };

      const txs = await module.update(targetConfig, {
        routingDestinations: [routingDestination],
        crossCollateralRouters: {
          [routingDestination]: [],
        },
      });

      expect(txs).to.have.lengthOf(0);
      expect(module.serialize().deployedFee).to.not.equal(emptyCcrf.address);

      const onchainConfig = await module.read({
        routingDestinations: [routingDestination],
        crossCollateralRouters: {
          [routingDestination]: [],
        },
      });
      assert(
        onchainConfig.type === TokenFeeType.CrossCollateralRoutingFee,
        `Must be ${TokenFeeType.CrossCollateralRoutingFee}`,
      );
      expect(
        onchainConfig.feeContracts[test4Chain]?.[DEFAULT_ROUTER_KEY]?.token,
      ).to.equal(token.address);
    });

    it('should preserve caller-provided CCR routers when diffing for redeploy', async () => {
      const initialSubFeeModule = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config,
      });
      const ccrf = await deployCrossCollateralRoutingFee(signer.address);
      const routerKey = hre.ethers.utils.hexZeroPad(signer.address, 32);
      const routingDestination = multiProvider.getDomainId(test4Chain);

      await ccrf.setCrossCollateralRouterFeeContracts(
        [routingDestination],
        [routerKey],
        [initialSubFeeModule.serialize().deployedFee],
      );

      const module = new EvmTokenFeeModule(multiProvider, {
        chain: test4Chain,
        config: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: signer.address,
          feeContracts: {
            [test4Chain]: {
              [routerKey]: config,
            },
          },
        },
        addresses: { deployedFee: ccrf.address },
      });

      const txs = await module.update(
        {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: signer.address,
          feeContracts: {
            [test4Chain]: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: signer.address,
                bps: BPS,
              },
            },
          },
        },
        {
          crossCollateralRouters: {
            [routingDestination]: [routerKey],
          },
        },
      );

      expect(txs).to.have.lengthOf(0);
      expect(module.serialize().deployedFee).to.not.equal(ccrf.address);

      const onchainConfig = await module.read({
        crossCollateralRouters: {
          [routingDestination]: [],
        },
      });
      assert(
        onchainConfig.type === TokenFeeType.CrossCollateralRoutingFee,
        `Must be ${TokenFeeType.CrossCollateralRoutingFee}`,
      );
      expect(
        onchainConfig.feeContracts[test4Chain]?.[DEFAULT_ROUTER_KEY]?.type,
      ).to.equal(TokenFeeType.LinearFee);
      expect(onchainConfig.feeContracts[test4Chain]?.[routerKey]).to.equal(
        undefined,
      );
    });

    it('should redeploy when fee type changes', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config,
      });
      const initialFeeAddress = module.serialize().deployedFee;
      const routingDestination = multiProvider.getDomainId(test4Chain);
      const txs = await module.update({
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        feeContracts: {
          [test4Chain]: {
            type: TokenFeeType.LinearFee,
            owner: signer.address,
            bps: BPS,
          },
        },
      });

      expect(txs).to.have.lengthOf(0);
      expect(module.serialize().deployedFee).to.not.equal(initialFeeAddress);
      const onchainConfig = await module.read({
        routingDestinations: [routingDestination],
      });
      assert(
        onchainConfig.type === TokenFeeType.RoutingFee,
        `Must be ${TokenFeeType.RoutingFee}`,
      );
    });

    it('should redeploy routing fee when adding a new destination', async () => {
      // Create a routing fee with one destination
      const initialFeeContracts = {
        [test4Chain]: config,
      };
      const routingFeeConfig: TokenFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: initialFeeContracts,
      };
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: routingFeeConfig,
      });

      // Update with an additional destination (test1)
      const test1Chain = TestChainName.test1;
      const updatedConfig: RoutingFeeConfig = {
        ...routingFeeConfig,
        feeContracts: {
          [test4Chain]: initialFeeContracts[test4Chain],
          [test1Chain]: {
            ...config,
            // New destination - should trigger deployment
          },
        },
      };

      // 1 tx: setFeeContract for the new destination
      const txs = await module.update(updatedConfig);
      expect(txs.length).to.equal(1);
      for (const tx of txs) {
        await multiProvider.sendTransaction(test4Chain, tx);
      }

      const onchainConfig = await module.read({
        routingDestinations: [
          multiProvider.getDomainId(test4Chain),
          multiProvider.getDomainId(test1Chain),
        ],
      });
      assert(
        onchainConfig.type === TokenFeeType.RoutingFee,
        `Must be ${TokenFeeType.RoutingFee}`,
      );
      expect(onchainConfig.feeContracts[test1Chain]).to.not.be.undefined;
    });
  });

  describe('expandConfig', () => {
    it('should expand config for zero-supply token using safe fallback', async () => {
      const factory = new ERC20Test__factory(signer);
      const zeroSupplyToken = await factory.deploy('ZeroSupply', 'ZERO', 0, 18);
      await zeroSupplyToken.deployed();

      const inputConfig: ResolvedTokenFeeConfigInput = {
        type: TokenFeeType.LinearFee,
        owner: signer.address,
        token: zeroSupplyToken.address,
        bps: 8n,
      };

      const expandedConfig = await EvmTokenFeeModule.expandConfig({
        config: inputConfig,
        multiProvider,
        chainName: test4Chain,
      });

      assert(
        expandedConfig.type === TokenFeeType.LinearFee,
        `Must be ${TokenFeeType.LinearFee}`,
      );
      const linearConfig = expandedConfig as LinearFeeConfig;
      expect(linearConfig.maxFee > 0n).to.be.true;
      expect(linearConfig.halfAmount > 0n).to.be.true;
      expect(linearConfig.bps).to.equal(8n);

      const roundTripBps = convertToBps(
        linearConfig.maxFee,
        linearConfig.halfAmount,
      );
      expect(roundTripBps).to.equal(8n);
    });

    it('should expand nested RoutingFee config for zero-supply token', async () => {
      const factory = new ERC20Test__factory(signer);
      const zeroSupplyToken = await factory.deploy('ZeroSupply', 'ZERO', 0, 18);
      await zeroSupplyToken.deployed();

      const inputConfig: ResolvedTokenFeeConfigInput = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: zeroSupplyToken.address,
        feeContracts: {
          [test4Chain]: {
            type: TokenFeeType.LinearFee,
            owner: signer.address,
            token: zeroSupplyToken.address,
            bps: 8n,
          },
        },
      };

      const expandedConfig = await EvmTokenFeeModule.expandConfig({
        config: inputConfig,
        multiProvider,
        chainName: test4Chain,
      });

      assert(
        expandedConfig.type === TokenFeeType.RoutingFee,
        `Must be ${TokenFeeType.RoutingFee}`,
      );
      const routingConfig = expandedConfig as RoutingFeeConfig;
      const nestedFee = routingConfig.feeContracts[test4Chain];
      assert(nestedFee, 'Nested fee must exist');
      assert(
        nestedFee.type === TokenFeeType.LinearFee,
        `Nested fee must be ${TokenFeeType.LinearFee}`,
      );

      const linearFee = nestedFee as LinearFeeConfig;
      expect(linearFee.maxFee > 0n).to.be.true;
      expect(linearFee.halfAmount > 0n).to.be.true;
      expect(linearFee.bps).to.equal(8n);
    });

    it('should expand config with explicit maxFee/halfAmount (no bps) and preserve values', async () => {
      const explicitMaxFee = 10_000n;
      const explicitHalfAmount = 5_000n;
      const expectedBps = convertToBps(explicitMaxFee, explicitHalfAmount);

      // Using type assertion because we're testing the pre-schema-transform input path
      // where bps is computed from maxFee/halfAmount at runtime
      const inputConfig = {
        type: TokenFeeType.LinearFee,
        owner: signer.address,
        token: token.address,
        maxFee: explicitMaxFee,
        halfAmount: explicitHalfAmount,
      } as ResolvedTokenFeeConfigInput;

      const expandedConfig = await EvmTokenFeeModule.expandConfig({
        config: inputConfig,
        multiProvider,
        chainName: test4Chain,
      });

      assert(
        expandedConfig.type === TokenFeeType.LinearFee,
        `Must be ${TokenFeeType.LinearFee}`,
      );
      const linearConfig = expandedConfig as LinearFeeConfig;

      expect(linearConfig.maxFee).to.equal(explicitMaxFee);
      expect(linearConfig.halfAmount).to.equal(explicitHalfAmount);
      expect(linearConfig.bps).to.equal(expectedBps);
    });

    it('should expand nested RoutingFee with explicit maxFee/halfAmount in child LinearFee', async () => {
      const explicitMaxFee = 10_000n;
      const explicitHalfAmount = 5_000n;

      // Using type assertion because we're testing the pre-schema-transform input path
      const inputConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: {
          [test4Chain]: {
            type: TokenFeeType.LinearFee,
            owner: signer.address,
            token: token.address,
            maxFee: explicitMaxFee,
            halfAmount: explicitHalfAmount,
          },
        },
      } as unknown as ResolvedTokenFeeConfigInput;

      const expandedConfig = await EvmTokenFeeModule.expandConfig({
        config: inputConfig,
        multiProvider,
        chainName: test4Chain,
      });

      assert(
        expandedConfig.type === TokenFeeType.RoutingFee,
        `Must be ${TokenFeeType.RoutingFee}`,
      );
      const routingConfig = expandedConfig as RoutingFeeConfig;
      const nestedFee = routingConfig.feeContracts[test4Chain];
      assert(nestedFee, 'Nested fee must exist');
      assert(
        nestedFee.type === TokenFeeType.LinearFee,
        `Nested fee must be ${TokenFeeType.LinearFee}`,
      );

      const linearFee = nestedFee as LinearFeeConfig;
      expect(linearFee.maxFee).to.equal(explicitMaxFee);
      expect(linearFee.halfAmount).to.equal(explicitHalfAmount);
    });

    it('should propagate parent token to nested feeContracts without explicit token', async () => {
      const inputConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: {
          [test4Chain]: {
            type: TokenFeeType.LinearFee,
            owner: signer.address,
            bps: 8n,
          },
        },
      } as unknown as ResolvedTokenFeeConfigInput;

      const expandedConfig = await EvmTokenFeeModule.expandConfig({
        config: inputConfig,
        multiProvider,
        chainName: test4Chain,
      });

      assert(
        expandedConfig.type === TokenFeeType.RoutingFee,
        `Must be ${TokenFeeType.RoutingFee}`,
      );
      const routingConfig = expandedConfig as RoutingFeeConfig;
      const nestedFee = routingConfig.feeContracts[test4Chain];
      assert(nestedFee, 'Nested fee must exist');
      expect(nestedFee.token).to.equal(token.address);
    });
  });

  describe('OffchainQuotedLinearFee', () => {
    let offchainConfig: OffchainQuotedLinearFeeConfig;

    before(() => {
      offchainConfig = TokenFeeConfigSchema.parse({
        type: TokenFeeType.OffchainQuotedLinearFee,
        owner: signer.address,
        token: token.address,
        maxFee: MAX_FEE,
        halfAmount: HALF_AMOUNT,
        bps: BPS,
        quoteSigners: [signer.address],
      }) as OffchainQuotedLinearFeeConfig;
    });

    it('should create and read OffchainQuotedLinearFee', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: offchainConfig,
      });
      const onchainConfig = await module.read();
      expect(normalizeConfig(onchainConfig)).to.deep.equal(
        normalizeConfig(offchainConfig),
      );
    });

    it('should not update if configs are the same', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: offchainConfig,
      });
      const txs = await module.update(offchainConfig);
      expect(txs).to.have.lengthOf(0);
    });

    it('should redeploy if fee params change', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: offchainConfig,
      });
      const updatedConfig = { ...offchainConfig, bps: BPS + 1n };
      await expectTxsAndUpdate(module, updatedConfig, 0);
      const onchainConfig = await module.read();
      assert(
        onchainConfig.type === TokenFeeType.OffchainQuotedLinearFee,
        `Must be ${TokenFeeType.OffchainQuotedLinearFee}`,
      );
      expect(onchainConfig.bps).to.eql(updatedConfig.bps);
    });

    it('should redeploy when transitioning from LinearFee to OffchainQuotedLinearFee', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config, // LinearFee
      });
      // 0 txs because redeploy happens inline
      await expectTxsAndUpdate(module, offchainConfig, 0);
      const onchainConfig = await module.read();
      assert(
        onchainConfig.type === TokenFeeType.OffchainQuotedLinearFee,
        `Must be ${TokenFeeType.OffchainQuotedLinearFee}`,
      );
    });

    it('should update signers without redeploying', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: offchainConfig,
      });
      const [, otherSigner] = await hre.ethers.getSigners();
      const updatedConfig: OffchainQuotedLinearFeeConfig = {
        ...offchainConfig,
        quoteSigners: [signer.address, otherSigner.address],
      };
      // 1 tx to add the new signer
      await expectTxsAndUpdate(module, updatedConfig, 1);
      const onchainConfig = await module.read();
      assert(
        onchainConfig.type === TokenFeeType.OffchainQuotedLinearFee,
        `Must be ${TokenFeeType.OffchainQuotedLinearFee}`,
      );
      expect(onchainConfig.quoteSigners).to.have.lengthOf(2);
      expect(onchainConfig.quoteSigners).to.include(otherSigner.address);
    });

    it('should remove signers without redeploying', async () => {
      const [, otherSigner] = await hre.ethers.getSigners();
      const twoSignerConfig: OffchainQuotedLinearFeeConfig = {
        ...offchainConfig,
        quoteSigners: [signer.address, otherSigner.address],
      };
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: test4Chain,
        config: twoSignerConfig,
      });
      const updatedConfig: OffchainQuotedLinearFeeConfig = {
        ...offchainConfig,
        quoteSigners: [signer.address],
      };
      // 1 tx to remove the other signer
      await expectTxsAndUpdate(module, updatedConfig, 1);
      const onchainConfig = await module.read();
      assert(
        onchainConfig.type === TokenFeeType.OffchainQuotedLinearFee,
        `Must be ${TokenFeeType.OffchainQuotedLinearFee}`,
      );
      expect(onchainConfig.quoteSigners).to.have.lengthOf(1);
      expect(onchainConfig.quoteSigners).to.include(signer.address);
    });
  });
});
