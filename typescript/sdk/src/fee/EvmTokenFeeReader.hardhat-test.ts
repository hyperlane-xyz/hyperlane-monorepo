import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { constants } from 'ethers';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomInt } from '../test/testUtils.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import { EvmTokenFeeReader } from './EvmTokenFeeReader.js';
import { TokenFeeConfig, TokenFeeConfigSchema, TokenFeeType } from './types.js';
import { ASSUMED_MAX_AMOUNT_FOR_ZERO_SUPPLY, convertToBps } from './utils.js';

export const MAX_FEE = 115792089237316195423570985008687907853269n;
export const HALF_AMOUNT = 578960446186580977117854925043439539266340n;
export const BPS = convertToBps(MAX_FEE, HALF_AMOUNT);

describe('EvmTokenFeeReader', () => {
  let multiProvider: MultiProvider;
  let signer: SignerWithAddress;
  let token: ERC20Test;

  const TOKEN_TOTAL_SUPPLY = '100000000000000000000';

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const factory = new ERC20Test__factory(signer);
    token = await factory.deploy('fake', 'FAKE', TOKEN_TOTAL_SUPPLY, 18);
    await token.deployed();
  });

  describe('LinearFee', () => {
    it('should read the token fee config', async () => {
      const config = TokenFeeConfigSchema.parse({
        type: TokenFeeType.LinearFee,
        maxFee: MAX_FEE,
        halfAmount: HALF_AMOUNT,
        bps: BPS,
        token: token.address,
        owner: signer.address,
      });
      const deployer = new EvmTokenFeeDeployer(
        multiProvider,
        TestChainName.test2,
      );
      const deployedContracts = await deployer.deploy({
        [TestChainName.test2]: config,
      });
      const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
      const tokenFee =
        deployedContracts[TestChainName.test2][TokenFeeType.LinearFee];
      const onchainConfig = await reader.deriveTokenFeeConfig({
        address: tokenFee.address,
      });
      expect(normalizeConfig(onchainConfig)).to.deep.equal(
        normalizeConfig({
          ...config,
          maxFee: MAX_FEE,
          halfAmount: HALF_AMOUNT,
          bps: BPS,
        }),
      );
    });

    it('should convert maxFee and halfAmount to bps', async () => {
      const maxFee = BigInt(randomInt(2, 100_000_000));
      const halfAmount = maxFee * 5n;

      const config = {
        type: TokenFeeType.LinearFee,
        owner: signer.address,
        token: token.address,
        maxFee,
        halfAmount,
        bps: convertToBps(maxFee, halfAmount),
      };
      const parsedConfig = TokenFeeConfigSchema.parse(config);
      const deployer = new EvmTokenFeeDeployer(
        multiProvider,
        TestChainName.test2,
      );
      await deployer.deploy({
        [TestChainName.test3]: parsedConfig,
      });

      const convertedBps = convertToBps(maxFee, halfAmount);
      expect(convertedBps).to.equal(BPS);
    });

    it('should be able to convert bps to maxFee and halfAmount, and back', async () => {
      const bps = BigInt(randomInt(1, 10_000));

      const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
      const { maxFee: convertedMaxFee, halfAmount: convertedHalfAmount } =
        reader.convertFromBps(bps);

      const convertedBps = convertToBps(convertedMaxFee, convertedHalfAmount);
      expect(convertedBps).to.equal(bps);
    });

    it('should use constant divisor for consistent fee derivation', async () => {
      const bps = 8n;
      const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
      const { maxFee, halfAmount } = reader.convertFromBps(bps);

      expect(maxFee > 0n).to.be.true;
      expect(halfAmount > 0n).to.be.true;

      const expectedMaxFee =
        BigInt(constants.MaxUint256.toString()) /
        ASSUMED_MAX_AMOUNT_FOR_ZERO_SUPPLY;
      expect(maxFee).to.equal(expectedMaxFee);

      const convertedBps = convertToBps(maxFee, halfAmount);
      expect(convertedBps).to.equal(bps);
    });

    it('should reject bps = 0 to prevent division by zero', () => {
      const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
      expect(() => reader.convertFromBps(0n)).to.throw(
        'bps must be > 0 to prevent division by zero',
      );
    });
  });

  describe('RoutingFee', () => {
    it('should be able to derive a routing fee config and its sub fees', async () => {
      const routingFeeConfig: TokenFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        maxFee: constants.MaxUint256.toBigInt(),
        halfAmount: constants.MaxUint256.toBigInt(),
        feeContracts: {
          [TestChainName.test2]: {
            owner: signer.address,
            token: token.address,
            type: TokenFeeType.LinearFee,
            maxFee: MAX_FEE,
            halfAmount: HALF_AMOUNT,
            bps: BPS,
          },
          [TestChainName.test3]: {
            owner: signer.address,
            token: token.address,
            type: TokenFeeType.LinearFee,
            maxFee: MAX_FEE,
            halfAmount: HALF_AMOUNT,
            bps: BPS,
          },
        },
      };
      const deployer = new EvmTokenFeeDeployer(
        multiProvider,
        TestChainName.test2,
      );
      const deployedContracts = await deployer.deploy({
        [TestChainName.test2]: routingFeeConfig,
      });

      const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);

      const destinations = [
        multiProvider.getDomainId(TestChainName.test2),
        multiProvider.getDomainId(TestChainName.test3),
      ];
      const routingFee = await reader.deriveTokenFeeConfig({
        address:
          deployedContracts[TestChainName.test2][TokenFeeType.RoutingFee]
            .address,
        routingDestinations: destinations,
      });
      expect(normalizeConfig(routingFee)).to.deep.equal(
        normalizeConfig(routingFeeConfig),
      );
    });

    it('should derive routing fee config without routingDestinations', async () => {
      const routingFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        feeContracts: {
          [TestChainName.test2]: {
            owner: signer.address,
            token: token.address,
            type: TokenFeeType.LinearFee,
            maxFee: MAX_FEE,
            halfAmount: HALF_AMOUNT,
            bps: BPS,
          },
        },
      };
      const deployer = new EvmTokenFeeDeployer(
        multiProvider,
        TestChainName.test2,
      );
      const deployedContracts = await deployer.deploy({
        [TestChainName.test2]: routingFeeConfig,
      });

      const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
      const routingFee = await reader.deriveTokenFeeConfig({
        address:
          deployedContracts[TestChainName.test2][TokenFeeType.RoutingFee]
            .address,
      });

      expect(routingFee.type).to.equal(TokenFeeType.RoutingFee);
      expect(routingFee.owner).to.equal(signer.address);
      expect(routingFee.token).to.equal(token.address);
      expect(
        Object.keys((routingFee as any).feeContracts ?? {}),
      ).to.have.length(0);
    });
  });
});
