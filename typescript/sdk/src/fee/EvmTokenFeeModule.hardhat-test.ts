import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { constants } from 'ethers';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';
import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeModule } from './EvmTokenFeeModule.js';
import { BPS, HALF_AMOUNT, MAX_FEE } from './EvmTokenFeeReader.hardhat-test.js';
import { TokenFeeReaderParams } from './EvmTokenFeeReader.js';
import {
  LinearFeeConfig,
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
  let config: TokenFeeConfig;

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
      maxFee: constants.MaxUint256.toBigInt(),
      halfAmount: constants.MaxUint256.toBigInt(),
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

    it(`should redeploy immutable fees if updating token for ${TokenFeeType.RoutingFee}`, async () => {
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

      await expectTxsAndUpdate(module, updatedConfig, 1, {
        routingDestinations: [multiProvider.getDomainId(test4Chain)],
      });
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

    it('should transfer ownership for each routing sub fee', async () => {
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
        normalizeConfig(onchainConfig.feeContracts?.[test4Chain]).owner,
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

      // Should work without routingDestinations param
      // Updating bps triggers a redeploy of the immutable LinearFee sub-contract,
      // which results in a setFeeContract transaction
      const txs = await module.update(updatedConfig);
      expect(txs.length).to.equal(1);
    });

    it('should deploy new sub-fee contract when adding a new destination', async () => {
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

      // Should generate transaction to set the new fee contract
      const txs = await module.update(updatedConfig);
      expect(txs.length).to.be.greaterThan(0);

      // Execute the transactions to actually set the fee contract on-chain
      for (const tx of txs) {
        await multiProvider.sendTransaction(test4Chain, tx);
      }

      // Verify the new sub-fee was deployed by reading the config
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
      expect(onchainConfig.feeContracts?.[test1Chain]).to.not.be.undefined;
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
      const nestedFee = routingConfig.feeContracts?.[test4Chain];
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
      } as ResolvedTokenFeeConfigInput;

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
      const nestedFee = routingConfig.feeContracts?.[test4Chain];
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
      } as ResolvedTokenFeeConfigInput;

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
      const nestedFee = routingConfig.feeContracts?.[test4Chain];
      assert(nestedFee, 'Nested fee must exist');
      expect(nestedFee.token).to.equal(token.address);
    });
  });
});
