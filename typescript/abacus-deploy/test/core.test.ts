import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { DeployEnvironment, ChainConfig } from '../src/config';
import { CoreDeploy, CoreInvariantChecker } from '../src/core';
import { getTestChains, outputDir, testCore as coreConfig } from './inputs';

describe('core', async () => {
  let core = new CoreDeploy();
  let chains: Record<types.Domain, ChainConfig>;
  const owners: Record<types.Domain, types.Address> = {};

  before(async () => {
    const [signer, owner] = await ethers.getSigners();
    chains = getTestChains(signer);
    Object.keys(chains).map((d) => {
      owners[parseInt(d)] = owner.address;
    });
  });

  it('deploys', async () => {
    await core.deploy(chains, coreConfig);
  });

  it('transfers ownership', async () => {
    await core.transferOwnership(owners);
  });

  it('checks', async () => {
    const checker = new CoreInvariantChecker(core, coreConfig, owners);
    await checker.check();
  });

  it('writes', async () => {
    core.writeContracts(outputDir);
    core.writeVerificationInput(outputDir);
    core.writeRustConfigs(DeployEnvironment.dev, outputDir);
  });

  it('reads', async () => {
    core = CoreDeploy.readContracts(chains, outputDir);
    const checker = new CoreInvariantChecker(core, coreConfig, owners);
    await checker.check();
  });
});
