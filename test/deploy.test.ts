import path from 'path';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { utils } from '@abacus-network/deploy';

import { YoAddresses, YoApp } from '../src';
import { YoChecker, YoDeployer } from '../src/deploy';
import { configs } from '../src/deploy/networks';
import { AbacusCore } from '@abacus-network/sdk';

describe('deploy', async () => {
  let deployer: YoDeployer<'test1' | 'test2' | 'test3'>;
  let addresses: Record<'test1' | 'test2' | 'test3', YoAddresses>;

  before(async () => {
    const transactionConfigs = {
      test1: configs.test1,
      test2: configs.test2,
      test3: configs.test3,
    };
    const [signer] = await ethers.getSigners();
    const multiProvider = utils.getMultiProviderFromConfigAndSigner(
      transactionConfigs,
      signer,
    );
    const core = AbacusCore.fromEnvironment('test', multiProvider);
    deployer = new YoDeployer(multiProvider, { owner: signer.address }, core);
  });

  it('deploys', async () => {
    addresses = await deployer.deploy();
  });

  it('writes', async () => {
    const base = './test/outputs/yo';
    deployer.writeVerification(path.join(base, 'verification'));
    deployer.writeContracts(addresses, path.join(base, 'contracts.ts'));
  });

  it('checks', async () => {
    const transactionConfigs = {
      test1: configs.test1,
      test2: configs.test2,
      test3: configs.test3,
    };
    const [signer] = await ethers.getSigners();
    const multiProvider = utils.getMultiProviderFromConfigAndSigner(
      transactionConfigs,
      signer,
    );
    const app = new YoApp(addresses, multiProvider);
    const checker = new YoChecker(multiProvider, app, {
      test1: { owner: signer.address },
      test2: { owner: signer.address },
      test3: { owner: signer.address },
    });
    await checker.check();
    checker.expectEmpty();
  });
});
