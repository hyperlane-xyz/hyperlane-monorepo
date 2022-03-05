import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ChainConfig } from '@abacus-network/abacus-deploy'
import { types } from '@abacus-network/utils'
import { testChains, testCore, testGovernance, testBridge } from './inputs';

import { CoreDeploy, CoreInvariantChecker } from '../src/core';
import { GovernanceDeploy, GovernanceConfig } from '../src/governance';
import { BridgeDeploy, BridgeInvariantChecker, BridgeConfig } from '../src/bridge';
import {XAppCoreAddresses} from '../src/config/core';

/*
 * Deploy the full Abacus suite on three chains
 */
// TODO(asa)
//   verification input
//   checks
//   restoring from file
describe('deploys', async () => {
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

  describe('with three domains', async () => {
    describe('core', async () => {
      it('deploys', async () => {
        await core.deploy(chains, testCore);
        await core.writeContracts('./test/outputs/core')
        for (const domain of core.domains) {
          xAppConfig[chains[domain].name] = {
            upgradeBeaconController: core.upgradeBeaconController(domain).address,
            xAppConnectionManager: core.xAppConnectionManager(domain).address,
          }
        }
      });

      it('checks', async () => {
        const checker = new CoreInvariantChecker(core, testCore)
        await checker.check()
      });

      it('saves', async () => {
        core.writeContracts('./test/outputs/core')
      });

      it('loads', async () => {
      });

      it('checks', async () => {
      });
    });

    describe('governance', async () => {
      let governanceConfig: GovernanceConfig;
      before(async () => {
        governanceConfig = {...testGovernance, core: xAppConfig }
      });

      it('deploys', async () => {
        await governance.deploy(chains, governanceConfig);
      });

      it('checks', async () => {
      });

      it('saves', async () => {
        governance.writeContracts('./test/outputs/governance')
      });

      it('loads', async () => {
      });

      it('checks', async () => {
      });
    });

    describe('governance', async () => {
      let bridgeConfig: BridgeConfig;
      before(async () => {
        bridgeConfig = {...testBridge, core: xAppConfig }
      });

      it('deploys bridge', async () => {
        await bridge.deploy(chains, bridgeConfig);
      });

      it('checks', async () => {
        const checker = new BridgeInvariantChecker(bridge, bridgeConfig)
        await checker.check()
      });

      it('saves', async () => {
        await bridge.writeContracts('./test/outputs/bridge')
      });

      it('loads', async () => {
      });

      it('checks', async () => {
      });
    });
  });
});
