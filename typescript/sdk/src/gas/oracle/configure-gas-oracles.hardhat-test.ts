import { expect } from 'chai';
import { utils } from 'ethers';
import hre from 'hardhat';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { testIgpConfig } from '../../test/testUtils.js';
import { ChainMap } from '../../types.js';
import { HyperlaneIgpDeployer } from '../HyperlaneIgpDeployer.js';
import { IgpConfig } from '../types.js';

import { oracleConfigToOracleData } from './types.js';

describe('HyperlaneIgpDeployer', () => {
  const local = TestChainName.test1;
  const remote = TestChainName.test2;
  let remoteId: number;
  let deployer: HyperlaneIgpDeployer;
  let igp: InterchainGasPaymaster;
  let multiProvider: MultiProvider;
  let testConfig: ChainMap<IgpConfig>;

  before(async () => {
    const [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    remoteId = multiProvider.getDomainId(remote);
    deployer = new HyperlaneIgpDeployer(multiProvider);
    testConfig = testIgpConfig([local, remote], signer.address);
    const contracts = await deployer.deploy(testConfig);
    igp = contracts[local].interchainGasPaymaster;
  });

  it('should deploy storage gas oracle with config given', async () => {
    // Assert
    const deployedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
    expect({
      gasPrice: deployedConfig.gasPrice,
      tokenExchangeRate: deployedConfig.tokenExchangeRate,
    }).to.deep.equal(
      oracleConfigToOracleData(testConfig[local].oracleConfig![remote]),
    );
  });

  it('should configure new oracle config', async () => {
    testConfig[local].oracleConfig![remote] = {
      tokenExchangeRate: utils.parseUnits('2', 'gwei').toString(),
      gasPrice: utils.parseUnits('3', 'gwei').toString(),
      tokenDecimals: 18,
    };

    const localContracts = await deployer.deployContracts(
      local,
      testConfig[local],
    );
    igp = localContracts.interchainGasPaymaster;

    const modifiedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
    expect({
      gasPrice: modifiedConfig.gasPrice,
      tokenExchangeRate: modifiedConfig.tokenExchangeRate,
    }).to.deep.equal(
      oracleConfigToOracleData(testConfig[local].oracleConfig![remote]),
    );
  });
});
