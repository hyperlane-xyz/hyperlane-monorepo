import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ChainConfig } from '@abacus-network/abacus-deploy'
import { types } from '@abacus-network/utils'
import { testChains, testCore, testGovernance, testBridge } from './inputs';

import { CoreDeploy, CoreInvariantChecker } from '../src/core';
import { GovernanceDeploy, GovernanceInvariantChecker, GovernanceConfig } from '../src/governance';
import { BridgeDeploy, BridgeInvariantChecker, BridgeConfig } from '../src/bridge';
import { RouterConfig } from '../src/router';

/*
 * Deploy the full Abacus suite on three chains
 */
// TODO(asa)
//   ownership transfer
//   verification input
//   checks
//   restoring from file
describe('deploys', async () => {
  let signer: SignerWithAddress;
  let core = new CoreDeploy();
  let governance = new GovernanceDeploy();
  let bridge = new BridgeDeploy();
  const routerConfig: RouterConfig = {
    core: {}
  }
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
          routerConfig.core[chains[domain].name] = {
            upgradeBeaconController: core.upgradeBeaconController(domain).address,
            xAppConnectionManager: core.xAppConnectionManager(domain).address,
          }
        }
      });

      it('checks', async () => {
        const checker = new CoreInvariantChecker(core, testCore)
        await checker.check()
      });

      it('writes', async () => {
        core.writeContracts('./test/outputs/core')
      });

      it('reads', async () => {
        core = CoreDeploy.readContracts(chains, './test/outputs/core')
        const checker = new CoreInvariantChecker(core, testCore)
        await checker.check()
      });
    });

    describe('governance', async () => {
      let governanceConfig: GovernanceConfig;
      before(async () => {
        governanceConfig = {...testGovernance, ...routerConfig }
      });

      it('deploys', async () => {
        await governance.deploy(chains, governanceConfig);
      });

      it('checks', async () => {
        const checker = new GovernanceInvariantChecker(governance, governanceConfig)
        await checker.check()
      });

      it('writes', async () => {
        governance.writeContracts('./test/outputs/governance')
      });

      it('reads', async () => {
        governance = GovernanceDeploy.readContracts(chains, './test/outputs/governance')
        const checker = new GovernanceInvariantChecker(governance, governanceConfig)
        await checker.check()
      });
    });

    describe('bridge', async () => {
      let bridgeConfig: BridgeConfig;
      before(async () => {
        bridgeConfig = {...testBridge, ...routerConfig }
      });

      it('deploys bridge', async () => {
        await bridge.deploy(chains, bridgeConfig);
      });

      it('checks', async () => {
        const checker = new BridgeInvariantChecker(bridge, bridgeConfig)
        await checker.check()
      });

      it('writes', async () => {
        await bridge.writeContracts('./test/outputs/bridge')
      });

      it('reads', async () => {
        bridge = BridgeDeploy.readContracts(chains, './test/outputs/bridge')
        const checker = new BridgeInvariantChecker(bridge, bridgeConfig)
        await checker.check()
      });
    });
  });
});
