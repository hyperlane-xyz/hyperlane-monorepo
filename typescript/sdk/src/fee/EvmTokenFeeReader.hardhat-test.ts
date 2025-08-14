import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { BigNumber, constants } from 'ethers';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory, LinearFee } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { HyperlaneContractsMap } from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import { EvmTokenFeeReader } from './EvmTokenFeeReader.js';
import { EvmTokenFeeFactories } from './contracts.js';
import { TokenFeeConfig, TokenFeeConfigSchema, TokenFeeType } from './types.js';

describe('EvmTokenFeeReader', () => {
  let multiProvider: MultiProvider;
  let signer: SignerWithAddress;
  let reader: EvmTokenFeeReader;
  let tokenFee: LinearFee;
  let deployer: EvmTokenFeeDeployer;
  let deployedContracts: HyperlaneContractsMap<EvmTokenFeeFactories>;
  let token: ERC20Test;

  let config: TokenFeeConfig;
  const TOKEN_TOTAL_SUPPLY = '100000000000000000000';
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

  it('should read the token fee config', async () => {
    reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
    tokenFee = deployedContracts[TestChainName.test2][TokenFeeType.LinearFee];
    const onchainConfig = await reader.deriveTokenFeeConfig(tokenFee.address);
    expect(normalizeConfig(onchainConfig)).to.deep.equal(
      normalizeConfig(config),
    );
  });

  it('should be able to convert bps to maxFee and halfAmount', async () => {
    const bps = 1;
    const config: TokenFeeConfig = TokenFeeConfigSchema.parse({
      type: TokenFeeType.LinearFee,
      owner: signer.address,
      token: token.address,
      bps,
    });

    const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
    const { maxFee: convertedMaxFee, halfAmount: convertedHalfAmount } =
      await reader.convertBpsToMaxFeeAndHalfAmount(config);
    expect(convertedMaxFee).to.equal(
      constants.MaxUint256.div(TOKEN_TOTAL_SUPPLY).toString(),
    );
    expect(convertedHalfAmount).to.equal(
      BigNumber.from(config.bps).mul(BigNumber.from(convertedMaxFee).mul(5000)),
    );
  });

  it.only('should convert maxFee and halfAmount to bps', async () => {
    const reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
    deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });
    tokenFee = deployedContracts[TestChainName.test2][TokenFeeType.LinearFee];
    const bps = await reader.convertMaxFeeAndHalfAmountToBps(tokenFee.address);
    expect(bps).to.equal('1');
  });
});
