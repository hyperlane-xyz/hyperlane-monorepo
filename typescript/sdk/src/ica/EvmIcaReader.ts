import { providers } from 'ethers';

import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
} from '@hyperlane-xyz/core';
import { Address, Domain, isZeroishAddress } from '@hyperlane-xyz/utils';

import {
  DerivedIcaRouterConfig,
  DerivedIcaRouterConfigSchema,
} from './types.js';

export class EvmIcaRouterReader {
  constructor(private readonly provider: providers.Provider) {}

  public async deriveConfig(address: Address): Promise<DerivedIcaRouterConfig> {
    const icaRouterInstance = InterchainAccountRouter__factory.connect(
      address,
      this.provider,
    );
    const owner = await icaRouterInstance.owner();

    const [knownDomains, mailboxAddress] = await Promise.all([
      icaRouterInstance.domains(),
      icaRouterInstance.mailbox(),
    ]);

    const remoteRouters = await this.deriveRemoteRoutersConfig(
      icaRouterInstance,
      knownDomains,
    );

    const rawConfig: DerivedIcaRouterConfig = {
      owner,
      address,
      mailbox: mailboxAddress,
      remoteIcaRouters: remoteRouters,
    };

    return DerivedIcaRouterConfigSchema.parse(rawConfig);
  }

  private async deriveRemoteRoutersConfig(
    icaRouterInstance: InterchainAccountRouter,
    knownDomains: ReadonlyArray<Domain>,
  ): Promise<DerivedIcaRouterConfig['remoteIcaRouters']> {
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
      const remoteRouter = remoteIcaRoutersConfig[idx][0];
      const ism = remoteIcaRoutersConfig[idx][1];

      acc[curr.toString()] = {
        address: remoteRouter,
        interchainSecurityModule: isZeroishAddress(ism) ? undefined : ism,
      };

      return acc;
    }, res);
  }
}
