import { types } from '@abacus-network/utils';
import {
  BridgeRouter,
  BridgeToken__factory,
  BridgeRouter__factory,
  ETHHelper__factory,
} from '@abacus-network/apps';
import { BridgeContractAddresses } from '@abacus-network/sdk';
import { AbacusRouterDeployer } from '../router';
import { BridgeConfig } from './types';

export class AbacusBridgeDeployer extends AbacusRouterDeployer<
  BridgeContractAddresses,
  BridgeConfig
> {
  async deployContracts(
    domain: types.Domain,
    config: BridgeConfig,
  ): Promise<BridgeContractAddresses> {
    const signer = this.mustGetSigner(domain);
    const name = this.mustResolveDomainName(domain);
    const core = config.core[name];
    if (!core) throw new Error('could not find core');

    const token = await this.deployProxiedContract(
      domain,
      'BridgeToken',
      new BridgeToken__factory(signer),
      core.upgradeBeaconController,
      [],
      [],
    );

    const router = await this.deployProxiedContract(
      domain,
      'BridgeRouter',
      new BridgeRouter__factory(signer),
      core.upgradeBeaconController,
      [],
      [token.addresses.beacon, core.xAppConnectionManager],
    );

    const addresses: BridgeContractAddresses = {
      router: router.addresses,
      token: token.addresses,
    };

    const weth = config.weth[name];
    if (weth) {
      const helper = await this.deployContract(
        domain,
        'ETH Helper',
        new ETHHelper__factory(signer),
        weth,
        router.address,
      );
      addresses.helper = helper.address;
    }
    return addresses;
  }

  mustGetRouter(domain: number): BridgeRouter {
    return BridgeRouter__factory.connect(
      this.mustGetAddresses(domain).router.proxy,
      this.mustGetSigner(domain),
    );
  }
}
