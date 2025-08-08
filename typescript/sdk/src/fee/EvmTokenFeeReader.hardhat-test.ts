import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory, LinearFee } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { HyperlaneContractsMap } from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomInt } from '../test/testUtils.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import { EvmTokenFeeReader } from './EvmTokenFeeReader.js';
import { EvmTokenFeeFactories } from './contracts.js';
import {
  LinearFeeInputConfig,
  TokenFeeConfig,
  TokenFeeConfigInput,
  TokenFeeConfigSchema,
  TokenFeeType,
} from './types.js';

describe('EvmTokenFeeReader', () => {
  let multiProvider: MultiProvider;
  let signer: SignerWithAddress;
  let reader: EvmTokenFeeReader;
  let tokenFee: LinearFee;
  let deployer: EvmTokenFeeDeployer;
  let deployedContracts: HyperlaneContractsMap<EvmTokenFeeFactories>;
  let token: ERC20Test;

  let config: TokenFeeConfigInput;
  const TOKEN_TOTAL_SUPPLY = '100000000000000000000';
  const BPS = 10000n;
  beforeEach(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    deployer = new EvmTokenFeeDeployer(multiProvider, TestChainName.test2);
    const factory = new ERC20Test__factory(signer);
    token = await factory.deploy('fake', 'FAKE', TOKEN_TOTAL_SUPPLY, 18);
    await token.deployed();

    config = TokenFeeConfigSchema.parse({
      type: TokenFeeType.LinearFee,
      maxFee: 10000000n,
      halfAmount: 5000000n,
      token: token.address,
      owner: signer.address,
    });

    deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });
  });

  describe('LinearFee', async () => {
    it('should read the token fee config', async () => {
      reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
      tokenFee = deployedContracts[TestChainName.test2][TokenFeeType.LinearFee];
      const onchainConfig = await reader.deriveTokenFeeConfig(tokenFee.address);
      expect(normalizeConfig(onchainConfig)).to.deep.equal(
        normalizeConfig({
          ...config,
          bps: BPS,
        }),
      );
    });

    it('should convert maxFee and halfAmount to bps', async () => {
      const maxFee = BigInt(randomInt(2, 100_000_000));
      const halfAmount = maxFee / 2n;

      const config: LinearFeeInputConfig = {
        type: TokenFeeType.LinearFee,
        owner: signer.address,
        token: token.address,
        maxFee,
        halfAmount,
      };
      const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test3);
      deployedContracts = await deployer.deploy({
        [TestChainName.test3]: config,
      });
      tokenFee = deployedContracts[TestChainName.test3][TokenFeeType.LinearFee];
      const convertedBps = await reader.convertToBps(maxFee, halfAmount);
      expect(convertedBps).to.equal(BPS);
    });

    it('should be able to convert bps to maxFee and halfAmount, and back', async () => {
      const bps = BigInt(randomInt(1, 10_000));
      const config = {
        type: TokenFeeType.LinearFee,
        owner: signer.address,
        token: token.address,
        bps,
      };

      const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
      const { maxFee: convertedMaxFee, halfAmount: convertedHalfAmount } =
        await reader.convertFromBps(config.bps, config.token);

      // Get bps using helper function
      const convertedBps = await reader.convertToBps(
        convertedMaxFee,
        convertedHalfAmount,
      );
      expect(convertedBps).to.equal(bps);
    });
  });

  describe('RoutingFee', async () => {
    it('should be able to derive a routing fee config and its sub fees', async () => {
      const routingFeeConfig: TokenFeeConfig = {
        type: TokenFeeType.RoutingFee,
        owner: signer.address,
        token: token.address,
        maxFee: BigInt(
          '115792089237316195423570985008687907853269984665640564039457584007913129639935', // Gets set as default at the smart contract level
        ),
        halfAmount: BigInt(
          '115792089237316195423570985008687907853269984665640564039457584007913129639935',
        ),
        feeContracts: {
          [TestChainName.test2]: {
            owner: signer.address,
            token: token.address,
            type: TokenFeeType.LinearFee,
            maxFee: BigInt(
              '1157920892373161954235709850086879078532699846656405640394',
            ),
            halfAmount: BigInt(
              '578960446186580977117854925043439539266349923328202820197',
            ),
            bps: BPS,
          },
          [TestChainName.test3]: {
            owner: signer.address,
            token: token.address,
            type: TokenFeeType.LinearFee,
            maxFee: BigInt(
              '1157920892373161954235709850086879078532699846656405640394',
            ),
            halfAmount: BigInt(
              '578960446186580977117854925043439539266349923328202820197',
            ),
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
      const routingFee = await reader.deriveTokenFeeConfig(
        deployedContracts[TestChainName.test2][TokenFeeType.RoutingFee].address,
        destinations,
      );
      expect(normalizeConfig(routingFee)).to.deep.equal(
        normalizeConfig(routingFeeConfig),
      );
    });
  });
});
