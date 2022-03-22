import '@nomiclabs/hardhat-waffle';
import { ethers } from 'hardhat';
import { types } from '@abacus-network/utils';
import { AbacusBridge } from '@abacus-network/sdk';
import { AbacusCoreDeployer } from '../src/core';
import {
  AbacusBridgeDeployer,
  AbacusBridgeChecker,
  BridgeConfig,
} from '../src/bridge';
import {
  core as coreConfig,
  registerMultiProviderTest,
  bridge as partialBridgeConfig,
} from '../config/environments/test';

describe('bridge', async () => {
  const coreDeployer = new AbacusCoreDeployer();
  const bridgeDeployer = new AbacusBridgeDeployer();
  const owners: Record<types.Domain, types.Address> = {};
  let bridge: AbacusBridge;
  let bridgeConfig: BridgeConfig;

  before(async () => {
    const [signer, owner] = await ethers.getSigners();
    registerMultiProviderTest(bridgeDeployer, signer);
    registerMultiProviderTest(coreDeployer, signer);
    await coreDeployer.deploy(coreConfig);

    bridgeConfig = { ...partialBridgeConfig, core: {} };
    coreDeployer.domainNumbers.map((domain) => {
      owners[domain] = owner.address;
      const coreAddresses = coreDeployer.mustGetAddresses(domain);
      bridgeConfig.core[coreDeployer.mustResolveDomainName(domain)] = {
        upgradeBeaconController: coreAddresses.upgradeBeaconController,
        xAppConnectionManager: coreAddresses.xAppConnectionManager,
      };
    });
  });

  it('deploys', async () => {
    await bridgeDeployer.deploy(bridgeConfig);
  });

  it('writes', async () => {
    bridgeDeployer.writeOutput('./test/outputs');
  });

  it('transfers ownership', async () => {
    bridge = new AbacusBridge(bridgeDeployer.addressesRecord);
    const [signer] = await ethers.getSigners();
    registerMultiProviderTest(bridge, signer);
    await bridge.transferOwnership(owners);
  });

  it('checks', async () => {
    const checker = new AbacusBridgeChecker(bridge, bridgeConfig, owners);
    await checker.check();
  });
});
