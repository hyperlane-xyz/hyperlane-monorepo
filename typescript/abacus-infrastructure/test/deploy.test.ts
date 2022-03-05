import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { types } from '@abacus-network/utils';

import { ChainConfig, CoreConfig } from '@abacus-network/abacus-deploy'
import { CoreDeploy } from '../src/core/CoreDeploy';
import { GovernanceDeploy } from '../src/governance/GovernanceDeploy';
import { BridgeDeploy } from '../src/bridge/BridgeDeploy';
import { GovernanceConfig, GovernanceAddresses } from '../src/config/governance';
import { BridgeConfig, BridgeAddresses } from '../src/config/bridge';
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
  const domains = [1000, 2000, 3000];
  const chains: Record<types.Domain, ChainConfig> = {}
  const core = new CoreDeploy();
  const governance = new GovernanceDeploy();
  const bridge = new BridgeDeploy();
  const xAppConfig: Record<string, XAppCoreAddresses> = {};

  before(async () => {
    [signer] = await ethers.getSigners();
    const overrides = {};
    for (const domain of domains) {
      chains[domain] = { name: `${domain.toString()}_str`, domain, signer, overrides };
    }
  });

  describe('three domain deploy', async () => {
    it('deploys core', async () => {
      const validators: Record<string, types.Address> = {};
      for (const domain of domains) {
        validators[chains[domain].name] = await signer.getAddress();
      }
      const config: CoreConfig = {
        processGas: 850_000,
        reserveGas: 15_000,
        validators,
        test: true,
      };
      await core.deploy(chains, config);
      await core.writeContracts('./test/outputs/core')
      for (const domain of domains) {
        xAppConfig[chains[domain].name] = {
          upgradeBeaconController: core.upgradeBeaconController(domain).address,
          xAppConnectionManager: core.xAppConnectionManager(domain).address,
        }
      }
    });

    it('deploys governance', async () => {
      const addresses: Record<string, GovernanceAddresses> = {};
      for (const domain of domains) {
        addresses[chains[domain].name] = {
          recoveryManager: await signer.getAddress(),
        }
      }
      // Only one governor.
      addresses[chains[1000].name].governor = await signer.getAddress()

      const config: GovernanceConfig = {
        recoveryTimelock: 180,
        addresses,
        core: xAppConfig
      };
      await governance.deploy(chains, config);
      await governance.writeContracts('./test/outputs/governance')
    });

    it('deploys bridge', async () => {
      const addresses: Record<string, BridgeAddresses> = {};
      // TODO(asa): weth needs to have "approve()"
      /*
      // Only one weth.
      addresses[chains[2000].name] = {
        weth: await signer.getAddress()
      }
      */

      const config: BridgeConfig = {
        addresses,
        core: xAppConfig
      };
      await bridge.deploy(chains, config);
      await bridge.writeContracts('./test/outputs/bridge')
    });
  });
});
