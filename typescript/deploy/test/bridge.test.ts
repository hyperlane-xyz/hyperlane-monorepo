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
import { core as coreConfig, registerMultiProvider, bridge as partialBridgeConfig } from '../config/environments/local';

describe('bridge', async () => {
  const coreDeployer = new AbacusCoreDeployer();
  const deployer = new AbacusBridgeDeployer();
  let bridgeConfig: BridgeConfig;
  const owners: Record<types.Domain, types.Address> = {};

  before(async () => {
    await registerMultiProvider(coreDeployer);
    await coreDeployer.deploy(coreConfig);

    const [_, owner] = await ethers.getSigners();
    bridgeConfig = { ...partialBridgeConfig, core: {} };
    coreDeployer.domainNumbers.map((domain) => {
      owners[domain] = owner.address;
      const coreAddresses = coreDeployer.mustGetAddresses(domain)
      bridgeConfig.core[coreDeployer.mustResolveDomainName(domain)] = {
        upgradeBeaconController: coreAddresses.upgradeBeaconController,
        xAppConnectionManager: coreAddresses.xAppConnectionManager,
      };
    });
  });

  it('deploys', async () => {
    await deployer.deploy(bridgeConfig);
  });

  it('writes', async () => {
    deployer.writeOutput('./test/outputs');
  });

  it('checks', async () => {
    const bridge = new AbacusBridge(deployer.addressesRecord())
    await registerMultiProvider(bridge)

    const checker = new AbacusBridgeChecker(
      bridge,
      bridgeConfig,
      owners,
    );
    await checker.check();
  });
});
