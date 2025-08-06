import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory, LinearFee } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { HyperlaneContractsMap } from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { normalizeConfig } from '../utils/ism.js';

import { assertTokenConfigForTest } from './EvmTokenFeeDeployer.hardhat-test.js';
import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import { EvmTokenFeeReader } from './EvmTokenFeeReader.js';
import { EvmTokenFeeFactories, evmTokenFeeFactories } from './contracts.js';
import { TokenFeeConfig, TokenFeeType } from './types.js';

describe('EvmTokenFeeReader', () => {
  let multiProvider: MultiProvider;
  let signer: SignerWithAddress;
  let reader: EvmTokenFeeReader;
  let tokenFee: LinearFee;
  let deployer: EvmTokenFeeDeployer;
  let deployedContracts: HyperlaneContractsMap<EvmTokenFeeFactories>;
  let token: ERC20Test;

  let config: TokenFeeConfig;

  beforeEach(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    deployer = new EvmTokenFeeDeployer(multiProvider, evmTokenFeeFactories);
    const factory = new ERC20Test__factory(signer);
    token = await factory.deploy('fake', 'FAKE', '100000000000000000000', 18);
    await token.deployed();

    config = {
      type: TokenFeeType.LinearFee,
      maxFee: '10000000',
      halfAmount: '5000000',
      bps: 0,
      token: token.address,
      owner: signer.address,
    };
    assertTokenConfigForTest(config);

    deployedContracts = await deployer.deploy({
      [TestChainName.test2]: config,
    });
  });

  it.only('should read the token fee config', async () => {
    reader = new EvmTokenFeeReader(multiProvider, TestChainName.test2);
    tokenFee = deployedContracts[TestChainName.test2][TokenFeeType.LinearFee];
    const onchainConfig = await reader.deriveTokenFeeConfig(tokenFee.address);
    expect(normalizeConfig(onchainConfig)).to.deep.equal(
      normalizeConfig(config),
    );
  });
});
