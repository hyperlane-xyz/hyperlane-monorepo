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
  RoutingFeeConfig,
  TokenFeeConfig,
  TokenFeeConfigInput,
  TokenFeeConfigSchema,
  TokenFeeType,
} from './types.js';

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
      const updatedConfig: TokenFeeConfigInput = {
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
  });
});
