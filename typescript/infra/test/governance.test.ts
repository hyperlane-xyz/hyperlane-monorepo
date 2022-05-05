import {
  AbacusCore,
  AbacusGovernance,
  ChainMap,
  GovernanceAddresses,
  MultiProvider
} from '@abacus-network/sdk';
import '@nomiclabs/hardhat-waffle';
import path from 'path';
import { TestNetworks } from '../config/environments/test/domains';
import { getCoreEnvironmentConfig } from '../scripts/utils';
import {
  AbacusGovernanceChecker,
  AbacusGovernanceDeployer,
  GovernanceConfig
} from '../src/governance';



describe('governance', async () => {
  const environment = 'test';

  let multiProvider: MultiProvider<TestNetworks>;
  let deployer: AbacusGovernanceDeployer<TestNetworks>;
  let addresses: ChainMap<TestNetworks, GovernanceAddresses>;
  let governanceConfig: ChainMap<TestNetworks, GovernanceConfig>;

  before(async () => {
    const config = getCoreEnvironmentConfig(environment);
    governanceConfig = config.governance;
    multiProvider = await config.getMultiProvider();

    const core = AbacusCore.fromEnvironment(environment, multiProvider);
    console.log(core);
    deployer = new AbacusGovernanceDeployer(
      multiProvider,
      governanceConfig,
      core,
    );
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
    await checker.check();
  });
});
