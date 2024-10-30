import { providers } from 'ethers';

import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  Ownable__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  bytes32ToAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { proxyAdmin } from '../deploy/proxy.js';

import { DerivedIcaRouterConfigSchema } from './schemas.js';
import { DerivedIcaRouterConfig } from './types.js';

export class EvmIcaRouterReader {
  constructor(private readonly provider: providers.Provider) {}

  public async deriveConfig(address: Address): Promise<DerivedIcaRouterConfig> {
    const icaRouterInstance = InterchainAccountRouter__factory.connect(
      address,
      this.provider,
    );
    const owner = await icaRouterInstance.owner();
    const proxyAddress = await proxyAdmin(this.provider, address);

    const proxyAdminInstance = Ownable__factory.connect(
      proxyAddress,
      this.provider,
    );
    const [proxyAdminOwner, knownDomains] = await Promise.all([
      proxyAdminInstance.owner(),
      icaRouterInstance.domains(),
    ]);

    const remoteRouters = await this._deriveRemoteRoutersConfig(
      icaRouterInstance,
      knownDomains,
    );

    const rawConfig: DerivedIcaRouterConfig = {
      owner,
      address,
      proxyAdmin: {
        address: proxyAddress,
        owner: proxyAdminOwner,
      },
      remoteIcaRouters: remoteRouters,
    };

    return DerivedIcaRouterConfigSchema.parse(rawConfig);
  }

  private async _deriveRemoteRoutersConfig(
    icaRouterInstance: InterchainAccountRouter,
    knownDomains: ReadonlyArray<Domain>,
  ): Promise<DerivedIcaRouterConfig['remoteIcaRouters']> {
    // TODO: improve this with the already existing utils
    const remoteIcaRoutersConfig = await Promise.all(
      knownDomains.map((domainId: Domain) => {
        return Promise.all([
          icaRouterInstance.routers(domainId),
          icaRouterInstance.isms(domainId),
        ]);
      }),
    );

    const res: DerivedIcaRouterConfig['remoteIcaRouters'] = {};

    return knownDomains.reduce((acc, curr, idx) => {
      const ism = bytes32ToAddress(remoteIcaRoutersConfig[idx][1]);

      acc[curr.toString()] = {
        address: bytes32ToAddress(remoteIcaRoutersConfig[idx][0]),
        interchainSecurityModule: isZeroishAddress(ism) ? undefined : ism,
      };

      return acc;
    }, res);
  }
}
