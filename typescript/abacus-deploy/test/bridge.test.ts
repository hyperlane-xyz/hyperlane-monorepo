import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { ChainConfig } from '../src/config';
import { CoreDeploy } from '../src/core';
import {
  BridgeDeploy,
  BridgeInvariantChecker,
  BridgeConfig,
} from '../src/bridge';
import {
  getTestChains,
  testCore as coreConfig,
  testBridge,
} from './inputs';

/*
 * Deploy the full Abacus suite on three chains
 */
describe('bridge', async () => {
  const core = new CoreDeploy();
  let chains: Record<types.Domain, ChainConfig>;
  let bridge = new BridgeDeploy();
  let bridgeConfig: BridgeConfig;
  const owners: Record<types.Domain, types.Address> = {};

  before(async () => {
    const [signer, owner] = await ethers.getSigners();
    chains = getTestChains(signer);
    await core.deploy(chains, coreConfig);
    bridgeConfig = { ...testBridge, core: {} };
    core.domains.map((domain) => {
      owners[domain] = owner.address;
      bridgeConfig.core[chains[domain].name] = {
        upgradeBeaconController: core.upgradeBeaconController(domain).address,
        xAppConnectionManager: core.xAppConnectionManager(domain).address,
      }
    })
  });

  it('deploys', async () => {
    await bridge.deploy(chains, bridgeConfig);
  });

  it('transfers ownership', async () => {
    await bridge.transferOwnership(owners);
  });

  it('checks', async () => {
    const checker = new BridgeInvariantChecker(
      bridge,
      bridgeConfig,
      owners,
    );
    await checker.check();
  });

  it('writes', async () => {
    bridge.writeContracts('./test/outputs/contracts/bridge');
    bridge.writeVerificationInput('./test/outputs/verification/bridge');
  });

  it('reads', async () => {
    bridge = BridgeDeploy.readContracts(
      chains,
      './test/outputs/contracts/bridge',
    );
    const checker = new BridgeInvariantChecker(
      bridge,
      bridgeConfig,
      owners,
    );
    await checker.check();
  });
});
