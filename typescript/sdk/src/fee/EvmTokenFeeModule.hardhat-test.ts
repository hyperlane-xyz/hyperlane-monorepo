import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { constants } from 'ethers';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { normalizeConfig } from '../utils/ism.js';

import {
  EvmTokenFeeModule,
  OptionalModuleParams,
} from './EvmTokenFeeModule.js';
import { BPS, HALF_AMOUNT, MAX_FEE } from './EvmTokenFeeReader.hardhat-test.js';
import {
  LinearFeeConfig,
  RoutingFeeConfig,
  TokenFeeConfig,
  TokenFeeConfigInput,
  TokenFeeConfigSchema,
  TokenFeeType,
} from './types.js';

describe('EvmTokenFeeModule', () => {
  const chain = TestChainName.test4;
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
    params?: OptionalModuleParams,
  ) {
    const txs = await feeModule.update(config, params);
    expect(txs.length).to.equal(n);

    for (const tx of txs) {
      await multiProvider.sendTransaction(chain, tx);
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
      chain: chain,
      config,
    });
    const onchainConfig = (await module.read()) as LinearFeeConfig;
    expect(onchainConfig.bps).to.equal(BPS);
  });

  it('should deploy and read the routing fee config', async () => {
    const routingFeeConfig: RoutingFeeConfig = {
      feeContracts: {
        [chain]: config,
      },
      owner: signer.address,
      token: token.address,
      maxFee: constants.MaxUint256.toBigInt(),
      halfAmount: constants.MaxUint256.toBigInt(),
      type: TokenFeeType.RoutingFee,
    };
    const module = await EvmTokenFeeModule.create({
      multiProvider,
      chain: chain,
      config: routingFeeConfig,
    });
    const routingDestination = multiProvider.getDomainId(chain);
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
        chain: chain,
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
          [chain]: config,
        },
      });
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: chain,
        config: routingConfig,
      });
      const chainId = multiProvider.getDomainId(chain);
      const txs = await module.update(routingConfig, {
        routingDestinations: [chainId],
      });
      expect(txs).to.have.lengthOf(0);
    });

    it('should not update if providing a bps that is the same as the result of calculating with maxFee and halfAmount', async () => {
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: chain,
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
        chain: chain,
        config,
      });
      const updatedConfig = { ...config, bps: BPS + 1n };
      await module.update(updatedConfig);
      const onchainConfig = (await module.read()) as LinearFeeConfig;
      expect(onchainConfig.bps).to.eql(updatedConfig.bps);
    });

    it(`should redeploy immutable fees if updating token for ${TokenFeeType.RoutingFee}`, async () => {
      const feeContracts = {
        [chain]: config,
      };
      const routingFeeConfig: TokenFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: feeContracts,
      };
      const module = await EvmTokenFeeModule.create({
        multiProvider,
        chain: chain,
        config: routingFeeConfig,
      });
      const updatedConfig = {
        ...routingFeeConfig,
        feeContracts: {
          [chain]: {
            ...feeContracts[chain],
            bps: BPS + 1n,
          },
        },
      };

      await expectTxsAndUpdate(module, updatedConfig, 1, {
        routingDestinations: [multiProvider.getDomainId(chain)],
      });
    });
  });
});
