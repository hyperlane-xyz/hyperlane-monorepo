import { utils } from '@abacus-network/deploy';
import {
  AbacusGovernance,
  ChainMap,
  GovernanceAddresses,
  MultiProvider,
  utils as sdkUtils,
} from '@abacus-network/sdk';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import path from 'path';
import { environment } from '../config/environments/test';
import {
  AbacusGovernanceChecker,
  AbacusGovernanceDeployer,
} from '../src/governance';

describe('governance', async () => {
  type networks = keyof typeof environment.transactionConfigs;
  let multiProvider: MultiProvider<networks>;
  let deployer: AbacusGovernanceDeployer<networks>;
  let owners: ChainMap<networks, string>;
  let addresses: ChainMap<networks, GovernanceAddresses>;
  const governanceConfig = environment.governance;

  before(async () => {
    const [signer] = await ethers.getSigners();
    multiProvider = utils.initHardhatMultiProvider(environment, signer);
    deployer = new AbacusGovernanceDeployer(multiProvider, governanceConfig);

    owners = sdkUtils.objMap(
      governanceConfig.addresses,
      (_, a) => a.governor ?? ethers.constants.AddressZero,
    );

    // abacusConnectionManager can be set to anything for these tests.
    if (!governanceConfig.abacusConnectionManager) {
      governanceConfig.abacusConnectionManager = sdkUtils.objMap(
        governanceConfig.addresses,
        () => signer.address,
      );
    }
  });

  it('deploys', async () => {
    addresses = await deployer.deploy();
  });

  it('writes', async () => {
    const base = './test/outputs/governance';
    deployer.writeVerification(path.join(base, 'verification'));
    deployer.writeContracts(addresses, path.join(base, 'contracts.ts'));
  });

  it('checks', async () => {
    const governance = new AbacusGovernance(addresses, multiProvider);
    const checker = new AbacusGovernanceChecker(
      multiProvider,
      governance,
      governanceConfig,
    );
    await checker.check(owners);
  });
});
