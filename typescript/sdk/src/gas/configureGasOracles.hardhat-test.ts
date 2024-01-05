import { expect } from 'chai';
import { ethers } from 'hardhat';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';

import { createIgpConfig } from '../config/igp';
import { chainNames } from '../config/test/chains';
import { storageGasOraclesConfig } from '../config/test/gasOracle';
import { multisigIsm } from '../config/test/multisigIsm';
import { owners } from '../config/test/owners';
import { MultiProvider } from '../providers/MultiProvider';

import { HyperlaneIgpDeployer } from './HyperlaneIgpDeployer';

const testIgpConfig = createIgpConfig(
  chainNames,
  storageGasOraclesConfig,
  multisigIsm,
  owners,
);

describe('HyperlaneIgpDeployer', () => {
  const local = 'test1';
  const remote = 'test2';
  let remoteId: number;
  let deployer: HyperlaneIgpDeployer;
  let igp: InterchainGasPaymaster;
  let multiProvider: MultiProvider;

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    remoteId = multiProvider.getDomainId(remote);
    deployer = new HyperlaneIgpDeployer(multiProvider);
  });

  it('should deploy storage gas oracle with config given', async () => {
    // Act
    igp = (await deployer.deploy(testIgpConfig))[local].interchainGasPaymaster;
    // Assert
    const deployedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
    expect(deployedConfig.tokenExchangeRate).to.equal(
      testIgpConfig[local].oracleConfig[remote].tokenExchangeRate,
    );
    expect(deployedConfig.gasPrice).to.equal(
      testIgpConfig[local].oracleConfig[remote].gasPrice,
    );
  });

  it('should configure new oracle config', async () => {
    // Assert
    const deployedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
    expect(deployedConfig.tokenExchangeRate).to.equal(
      testIgpConfig[local].oracleConfig[remote].tokenExchangeRate,
    );
    expect(deployedConfig.gasPrice).to.equal(
      testIgpConfig[local].oracleConfig[remote].gasPrice,
    );

    // Arrange
    testIgpConfig[local].oracleConfig[remote].tokenExchangeRate =
      ethers.utils.parseUnits('2', 'gwei');
    testIgpConfig[local].oracleConfig[remote].gasPrice =
      ethers.utils.parseUnits('3', 'gwei');

    // Act
    await deployer.configureStorageGasOracle(
      local,
      igp,
      testIgpConfig[local].oracleConfig,
    );

    // Assert
    const modifiedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
    expect(modifiedConfig.tokenExchangeRate).to.equal(
      testIgpConfig[local].oracleConfig[remote].tokenExchangeRate,
    );
    expect(modifiedConfig.gasPrice).to.equal(
      testIgpConfig[local].oracleConfig[remote].gasPrice,
    );
  });
});
