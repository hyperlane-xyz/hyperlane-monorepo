import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { ChainConfig } from '../src/config';
import { CoreDeploy } from '../src/core';
import {
  GovernanceDeploy,
  GovernanceInvariantChecker,
  GovernanceConfig,
} from '../src/governance';
import {
  getTestChains,
  outputDir,
  testCore as coreConfig,
  testGovernance,
} from './inputs';

describe('governance', async () => {
  const core = new CoreDeploy();
  let chains: Record<types.Domain, ChainConfig>;
  let governance = new GovernanceDeploy();
  let governanceConfig: GovernanceConfig;
  const owners: Record<types.Domain, types.Address> = {};

  before(async () => {
    const [signer] = await ethers.getSigners();
    chains = getTestChains(signer);
    await core.deploy(chains, coreConfig);
    governanceConfig = { ...testGovernance, core: {} };
    core.domains.map((domain) => {
      const name = chains[domain].name;
      const addresses = testGovernance.addresses[name];
      if (addresses === undefined) throw new Error('could not find addresses');
      const owner = addresses.governor;
      owners[domain] = owner ? owner : ethers.constants.AddressZero;
      governanceConfig.core[name] = {
        upgradeBeaconController: core.upgradeBeaconController(domain).address,
        xAppConnectionManager: core.xAppConnectionManager(domain).address,
      };
    });
  });

  it('deploys', async () => {
    await governance.deploy(chains, governanceConfig);
  });

  it('checks', async () => {
    const checker = new GovernanceInvariantChecker(
      governance,
      governanceConfig,
      owners,
    );
    await checker.check();
  });

  it('writes', async () => {
    governance.writeOutput(outputDir);
  });

  it('reads', async () => {
    governance = GovernanceDeploy.readContracts(chains, outputDir);
    const checker = new GovernanceInvariantChecker(
      governance,
      governanceConfig,
      owners,
    );
    await checker.check();
  });
});
