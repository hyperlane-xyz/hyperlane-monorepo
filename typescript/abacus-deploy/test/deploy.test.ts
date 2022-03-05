import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ChainConfig } from '@abacus-network/abacus-deploy';
import { types } from '@abacus-network/utils';
import {
  testChains,
  testCore as coreConfig,
  testGovernance,
  testBridge,
} from './inputs';

import { CoreDeploy, CoreInvariantChecker } from '../src/core';
import {
  GovernanceDeploy,
  GovernanceInvariantChecker,
  GovernanceConfig,
} from '../src/governance';
import {
  BridgeDeploy,
  BridgeInvariantChecker,
  BridgeConfig,
} from '../src/bridge';
import { RouterConfig } from '../src/router';

/*
 * Deploy the full Abacus suite on three chains
 */
// TODO(asa)
//   verification input
describe('three domains', async () => {
  let signer: SignerWithAddress;
  let core = new CoreDeploy();
  let governance = new GovernanceDeploy();
  let bridge = new BridgeDeploy();
  const routerConfig: RouterConfig = {
    core: {},
  };
  const chains: Record<types.Domain, ChainConfig> = {};
  let governanceConfig: GovernanceConfig;
  let bridgeConfig: BridgeConfig;
  let governanceRouters: Record<types.Domain, types.Address> = {};
  let governors: Record<types.Domain, types.Address> = {};

  before(async () => {
    [signer] = await ethers.getSigners();
    testChains.map((chain) => {
      chains[chain.domain] = { ...chain, signer };
      const governor = testGovernance.addresses[chain.name].governor;
      governors[chain.domain] = governor
        ? governor
        : ethers.constants.AddressZero;
    });
  });

  describe('deploy', async () => {
    it('core', async () => {
      await core.deploy(chains, coreConfig);
      await core.writeContracts('./test/outputs/core');
      for (const domain of core.domains) {
        routerConfig.core[chains[domain].name] = {
          upgradeBeaconController: core.upgradeBeaconController(domain).address,
          xAppConnectionManager: core.xAppConnectionManager(domain).address,
        };
      }
    });

    it('governance', async () => {
      governanceConfig = { ...testGovernance, ...routerConfig };
      await governance.deploy(chains, governanceConfig);
      governanceRouters = governance.routerAddresses();
    });

    it('bridge', async () => {
      bridgeConfig = { ...testBridge, ...routerConfig };
      await bridge.deploy(chains, bridgeConfig);
    });
  });

  describe('transfer ownership', async () => {
    it('core', async () => {
      await core.transferOwnership(governanceRouters);
    });

    it('bridge', async () => {
      await bridge.transferOwnership(governanceRouters);
    });
  });

  describe('checks', async () => {
    it('core', async () => {
      const checker = new CoreInvariantChecker(
        core,
        coreConfig,
        governanceRouters,
      );
      await checker.check();
    });

    it('governance', async () => {
      const checker = new GovernanceInvariantChecker(
        governance,
        governanceConfig,
        governors,
      );
      await checker.check();
    });

    it('bridge', async () => {
      const checker = new BridgeInvariantChecker(
        bridge,
        bridgeConfig,
        governanceRouters,
      );
      await checker.check();
    });
  });

  describe('writes', async () => {
    it('core', async () => {
      core.writeContracts('./test/outputs/core');
    });

    it('governance', async () => {
      governance.writeContracts('./test/outputs/governance');
    });

    it('bridge', async () => {
      await bridge.writeContracts('./test/outputs/bridge');
    });
  });

  describe('reads', async () => {
    it('core', async () => {
      core = CoreDeploy.readContracts(chains, './test/outputs/core');
      const checker = new CoreInvariantChecker(
        core,
        coreConfig,
        governanceRouters,
      );
      await checker.check();
    });

    it('governance', async () => {
      governance = GovernanceDeploy.readContracts(
        chains,
        './test/outputs/governance',
      );
      const checker = new GovernanceInvariantChecker(
        governance,
        governanceConfig,
        governors,
      );
      await checker.check();
    });

    it('bridge', async () => {
      bridge = BridgeDeploy.readContracts(chains, './test/outputs/bridge');
      const checker = new BridgeInvariantChecker(
        bridge,
        bridgeConfig,
        governanceRouters,
      );
      await checker.check();
    });
  });
});
