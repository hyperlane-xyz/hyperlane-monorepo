import { expect } from 'chai';
import { ethers } from 'hardhat';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';

import { MultiProvider } from '../../providers/MultiProvider';
import { testIgpConfig } from '../../test/testUtils';
import { ChainMap } from '../../types';
import { HyperlaneIgpDeployer } from '../HyperlaneIgpDeployer';
import { IgpConfig } from '../types';

describe('HyperlaneIgpDeployer', () => {
  const local = 'test1';
  const remote = 'test2';
  let remoteId: number;
  let deployer: HyperlaneIgpDeployer;
  let igp: InterchainGasPaymaster;
  let multiProvider: MultiProvider;
  let testConfig: ChainMap<IgpConfig>;

  before(async () => {
    const [signer] = await ethers.getSigners();
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
    }).to.deep.equal(testConfig[local].oracleConfig![remote]);
  });

  it('should configure new oracle config', async () => {
    testConfig[local].oracleConfig![remote] = {
      tokenExchangeRate: ethers.utils.parseUnits('2', 'gwei'),
      gasPrice: ethers.utils.parseUnits('3', 'gwei'),
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
    }).to.deep.equal(testConfig[local].oracleConfig![remote]);
  });
});
