import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ChainConfig } from '@abacus-network/abacus-deploy'
import { types } from '@abacus-network/utils'
import { testChains, testCore, testGovernance, testBridge } from './inputs';

import { CoreDeploy } from '../src/core';
import { GovernanceDeploy } from '../src/governance';
import { BridgeDeploy } from '../src/bridge';
import {XAppCoreAddresses} from '../src/config/core';

/*
 * Deploy the full Abacus suite on three chains
 */
// TODO(asa)
//   verification input
//   checks
//   restoring from file
describe('CoreDeploy', async () => {
  let signer: SignerWithAddress;
  const core = new CoreDeploy();
  const governance = new GovernanceDeploy();
  const bridge = new BridgeDeploy();
  const xAppConfig: Record<string, XAppCoreAddresses> = {};
  const chains: Record<types.Domain, ChainConfig> = {};

  before(async () => {
    [signer] = await ethers.getSigners();
    testChains.map((chain) => {
      chains[chain.domain] = { ...chain, signer };
    });
  });

  describe('three domain deploy', async () => {
    it('deploys core', async () => {
      await core.deploy(chains, testCore);
      await core.writeContracts('./test/outputs/core')
      for (const domain of core.domains) {
        xAppConfig[chains[domain].name] = {
          upgradeBeaconController: core.upgradeBeaconController(domain).address,
          xAppConnectionManager: core.xAppConnectionManager(domain).address,
        }
      }
    });

    it('deploys governance', async () => {
      const governanceConfig = {...testGovernance, core: xAppConfig }
      await governance.deploy(chains, governanceConfig);
      await governance.writeContracts('./test/outputs/governance')
    });

    it('deploys bridge', async () => {
      const bridgeConfig = {...testBridge, core: xAppConfig }
      await bridge.deploy(chains, bridgeConfig);
      await bridge.writeContracts('./test/outputs/bridge')
    });
  });
});
