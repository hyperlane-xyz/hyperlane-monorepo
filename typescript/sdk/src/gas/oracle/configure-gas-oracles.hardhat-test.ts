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

  // Note: We use .eq() method for BigNumber comparisons instead of deep.equal for robustness:
  // If multiple copies of the BigNumber class are loaded (e.g., from separate ethers installations
  // in solidity/ and typescript/sdk/), deep.equal will fail because they're different class instances,
  // even though the values are identical. BigNumber.eq() works correctly across different instances.
  it('should deploy storage gas oracle with config given', async () => {
    // Assert
    const deployedConfig = await igp.getExchangeRateAndGasPrice(remoteId);
    const expected = oracleConfigToOracleData(
      testConfig[local].oracleConfig![remote],
    );

    expect(
      deployedConfig.gasPrice.eq(expected.gasPrice),
      `gasPrice mismatch: expected ${expected.gasPrice.toString()}, got ${deployedConfig.gasPrice.toString()}`,
    ).to.be.true;
    expect(
      deployedConfig.tokenExchangeRate.eq(expected.tokenExchangeRate),
      `tokenExchangeRate mismatch: expected ${expected.tokenExchangeRate.toString()}, got ${deployedConfig.tokenExchangeRate.toString()}`,
    ).to.be.true;
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
    const expected = oracleConfigToOracleData(
      testConfig[local].oracleConfig![remote],
    );

    expect(
      modifiedConfig.gasPrice.eq(expected.gasPrice),
      `gasPrice mismatch: expected ${expected.gasPrice.toString()}, got ${modifiedConfig.gasPrice.toString()}`,
    ).to.be.true;
    expect(
      modifiedConfig.tokenExchangeRate.eq(expected.tokenExchangeRate),
      `tokenExchangeRate mismatch: expected ${expected.tokenExchangeRate.toString()}, got ${modifiedConfig.tokenExchangeRate.toString()}`,
    ).to.be.true;
  });
});
