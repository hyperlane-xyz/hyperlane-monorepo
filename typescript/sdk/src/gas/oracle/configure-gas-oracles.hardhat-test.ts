import { expect } from 'chai';
import { utils } from 'ethers';
import hre from 'hardhat';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';

import { TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { getHardhatSigners } from '../../test/hardhatViem.js';
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

  const toBigInt = (value: unknown): bigint =>
    value === undefined || value === null ? 0n : BigInt(value.toString());
  const getGasPrice = (value: any): bigint =>
    toBigInt(value?.gasPrice ?? value?.[1]);
  const getTokenExchangeRate = (value: any): bigint =>
    toBigInt(value?.tokenExchangeRate ?? value?.[0]);

  before(async () => {
    const [signer] = await getHardhatSigners();
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
    const expected = oracleConfigToOracleData(
      testConfig[local].oracleConfig![remote],
    );

    expect(
      getGasPrice(deployedConfig) === expected.gasPrice,
      `gasPrice mismatch: expected ${expected.gasPrice.toString()}, got ${getGasPrice(
        deployedConfig,
      ).toString()}`,
    ).to.be.true;
    expect(
      getTokenExchangeRate(deployedConfig) === expected.tokenExchangeRate,
      `tokenExchangeRate mismatch: expected ${expected.tokenExchangeRate.toString()}, got ${getTokenExchangeRate(
        deployedConfig,
      ).toString()}`,
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
      getGasPrice(modifiedConfig) === expected.gasPrice,
      `gasPrice mismatch: expected ${expected.gasPrice.toString()}, got ${getGasPrice(
        modifiedConfig,
      ).toString()}`,
    ).to.be.true;
    expect(
      getTokenExchangeRate(modifiedConfig) === expected.tokenExchangeRate,
      `tokenExchangeRate mismatch: expected ${expected.tokenExchangeRate.toString()}, got ${getTokenExchangeRate(
        modifiedConfig,
      ).toString()}`,
    ).to.be.true;
  });
});
