import { expect } from 'chai';
import { ethers } from 'hardhat';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';

import { MultiProvider } from '../../providers/MultiProvider';
import { testIgpConfig } from '../../test/testUtils';
import { ChainMap } from '../../types';
import { HyperlaneIgpDeployer } from '../HyperlaneIgpDeployer';
import { IgpConfig } from '../types';

import { OracleConfig } from './types';

describe('HyperlaneIgpDeployer', () => {
  const local = 'test1';
  const remote = 'test2';
  let remoteId: number;
  let deployer: HyperlaneIgpDeployer;
  let igp: InterchainGasPaymaster;
  let multiProvider: MultiProvider;
  let testConfig: ChainMap<IgpConfig & Partial<OracleConfig>>;

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    remoteId = multiProvider.getDomainId(remote);
    deployer = new HyperlaneIgpDeployer(multiProvider);
    testConfig = testIgpConfig([local, remote], signer.address);
  });

  it('should deploy storage gas oracle with config given', async () => {
    // Act
    igp = (await deployer.deploy(testConfig))[local].interchainGasPaymaster;
    // Assert
    const deployedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
    if (testConfig[local].oracleConfig) {
      expect(deployedConfig.tokenExchangeRate).to.equal(
        testConfig[local].oracleConfig[remote].tokenExchangeRate,
      );
      expect(deployedConfig.gasPrice).to.equal(
        testConfig[local].oracleConfig[remote].gasPrice,
      );
    }
  });

  it('should configure new oracle config', async () => {
    // Assert
    const deployedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
    if (testConfig[local].oracleConfig) {
      expect(deployedConfig.tokenExchangeRate).to.equal(
        testConfig[local].oracleConfig[remote].tokenExchangeRate,
      );
      expect(deployedConfig.gasPrice).to.equal(
        testConfig[local].oracleConfig[remote].gasPrice,
      );

      // Arrange
      testConfig[local].oracleConfig[remote].tokenExchangeRate =
        ethers.utils.parseUnits('2', 'gwei');
      testConfig[local].oracleConfig[remote].gasPrice = ethers.utils.parseUnits(
        '3',
        'gwei',
      );

      // Act
      await deployer.configureStorageGasOracle(
        local,
        igp,
        testConfig[local].oracleConfig,
      );

      // Assert
      const modifiedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
      expect(modifiedConfig.tokenExchangeRate).to.equal(
        testConfig[local].oracleConfig[remote].tokenExchangeRate,
      );
      expect(modifiedConfig.gasPrice).to.equal(
        testConfig[local].oracleConfig[remote].gasPrice,
      );
    }
  });
});
