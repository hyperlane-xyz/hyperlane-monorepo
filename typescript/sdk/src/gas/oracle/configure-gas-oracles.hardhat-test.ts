import { ethers } from 'hardhat';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';

import { MultiProvider } from '../../providers/MultiProvider';
import { testIgpConfig } from '../../test/testUtils';
import { HyperlaneIgpDeployer } from '../HyperlaneIgpDeployer';

describe('HyperlaneIgpDeployer', () => {
  const local = 'test1';
  const remote = 'test2';
  let remoteId: number;
  let deployer: HyperlaneIgpDeployer;
  let igp: InterchainGasPaymaster;
  let multiProvider: MultiProvider;
  const testConfig = testIgpConfig([local, remote]);

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    remoteId = multiProvider.getDomainId(remote);
    deployer = new HyperlaneIgpDeployer(multiProvider);
  });

  it('should deploy storage gas oracle with config given', async () => {
    // Act
    igp = (await deployer.deploy(testConfig))[local].interchainGasPaymaster;
    console.log('testConfig', testConfig);
    // Assert
    // const deployedConfig =
    await igp.getExchangeRateAndGasPrice(remoteId);
    // expect(deployedConfig.tokenExchangeRate).to.equal(
    //   igpConfig[local].oracleConfig[remote].tokenExchangeRate,
    // );
    // expect(deployedConfig.gasPrice).to.equal(
    //   igpConfig[local].oracleConfig[remote].gasPrice,
    // );
  });

  // it('should configure new oracle config', async () => {
  //   // Assert
  //   const deployedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
  //   expect(deployedConfig.tokenExchangeRate).to.equal(
  //     testIgpConfig[local].oracleConfig[remote].tokenExchangeRate,
  //   );
  //   expect(deployedConfig.gasPrice).to.equal(
  //     testIgpConfig[local].oracleConfig[remote].gasPrice,
  //   );

  //   // Arrange
  //   testIgpConfig[local].oracleConfig[remote].tokenExchangeRate =
  //     ethers.utils.parseUnits('2', 'gwei');
  //   testIgpConfig[local].oracleConfig[remote].gasPrice =
  //     ethers.utils.parseUnits('3', 'gwei');

  //   // Act
  //   await deployer.configureStorageGasOracle(
  //     local,
  //     igp,
  //     testIgpConfig[local].oracleConfig,
  //   );

  //   // Assert
  //   const modifiedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
  //   expect(modifiedConfig.tokenExchangeRate).to.equal(
  //     testIgpConfig[local].oracleConfig[remote].tokenExchangeRate,
  //   );
  //   expect(modifiedConfig.gasPrice).to.equal(
  //     testIgpConfig[local].oracleConfig[remote].gasPrice,
  //   );
  // });
});
