import path from 'path';
import { ethers } from 'ethers';
import { utils, types } from '@abacus-network/utils';
import { BridgeToken__factory, BridgeRouter__factory, ETHHelper__factory} from '@abacus-network/apps';
import { AbacusBridge, BridgeContractAddresses, ChainName } from '@abacus-network/sdk';
import { AbacusAppDeployer } from '../deploy';
import { BridgeConfig } from './types';

export class AbacusBridgeDeployer extends AbacusAppDeployer<BridgeContractAddresses, BridgeConfig> {
  configDirectory(directory: string) {
    return path.join(directory, 'bridge');
  }

  async deployContracts(
    domain: types.Domain,
    config: BridgeConfig,
  ): Promise<BridgeContractAddresses> {
    const signer = this.mustGetSigner(domain);
    const name = this.mustResolveDomainName(domain)
    const core = config.core[name];
    if (!core) throw new Error('could not find core');

    const token = await this.deployBeaconProxy(
      domain, 'BridgeToken',
      new BridgeToken__factory(signer),
      core.upgradeBeaconController,
      [],
      [],
    );

    const router = await this.deployBeaconProxy(
      domain, 'BridgeRouter',
      new BridgeRouter__factory(signer),
      core.upgradeBeaconController,
      [],
      [token.beacon.address, core.xAppConnectionManager],
    );

    const addresses: BridgeContractAddresses = {
      router: router.toObject(),
      token: token.toObject(),
    }

    const weth = config.weth[name];
    if (weth) {
      const helper = await this.deployContract(
        domain, 'ETH Helper',
        new ETHHelper__factory(signer),
        weth,
        router.address,
      );
      addresses.helper = helper.address;
    }
    return addresses
  }

  // TODO(asa): Consider sharing router specific code
  async deploy(config: BridgeConfig) {
    super.deploy(config);
    const app = this.app();
    // Make all routers aware of eachother.
    for (const local of this.domainNumbers) {
      const router = app.mustGetContracts(local).router;
      for (const remote of this.remoteDomainNumbers(local)) {
        const remoteRouter = app.mustGetContracts(remote).router
        await router.enrollRemoteRouter(
          remote,
          utils.addressToBytes32(remoteRouter.address),
        );
      }
    }
  }

  app(): AbacusBridge {
    const addressesRecord: Partial<Record<ChainName, BridgeContractAddresses>> = {}
    this.addresses.forEach((addresses: BridgeContractAddresses, domain: number) => {
      addressesRecord[this.mustResolveDomainName(domain)] = addresses;
    });
    const app = new AbacusBridge(addressesRecord);
    this.signers.forEach((signer: ethers.Signer, domain: number) => {
      app.registerSigner(domain, signer)
    });
    return app
  }
}
