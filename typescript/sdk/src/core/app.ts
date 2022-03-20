import {
  XAppConnectionManager,
  XAppConnectionManager__factory,
  ValidatorManager,
  ValidatorManager__factory,
  Outbox,
  Outbox__factory,
  Inbox,
  Inbox__factory,
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { AbacusApp } from '../app';
import { AbacusAppContracts } from '../contracts';
import { ChainName, NameOrDomain, ProxiedAddress } from '../types';

export type CoreContractAddresses = {
  upgradeBeaconController: types.Address;
  xAppConnectionManager: types.Address;
  validatorManager: types.Address;
  outbox: ProxiedAddress;
  inboxes: Record<ChainName, ProxiedAddress>;
};

export class CoreContracts extends AbacusAppContracts<CoreContractAddresses> {
  inbox(chain: ChainName): Inbox {
    const inbox = this._addresses.inboxes[chain];
    if (!inbox) {
      throw new Error(`No inbox for ${chain}`);
    }
    return Inbox__factory.connect(inbox.proxy, this.connection);
  }

  get outbox(): Outbox {
    return Outbox__factory.connect(
      this._addresses.outbox.proxy,
      this.connection,
    );
  }

  get validatorManager(): ValidatorManager {
    return ValidatorManager__factory.connect(
      this._addresses.validatorManager,
      this.connection,
    );
  }

  get xAppConnectionManager(): XAppConnectionManager {
    return XAppConnectionManager__factory.connect(
      this._addresses.xAppConnectionManager,
      this.connection,
    );
  }
}

export class AbacusCore extends AbacusApp<
  CoreContractAddresses,
  CoreContracts
> {
  constructor(addresses: Partial<Record<ChainName, CoreContractAddresses>>) {
    super();
    for (const chain of Object.keys(addresses) as ChainName[]) {
      const domain = this.resolveDomain(chain);
      this.contracts.set(domain, new CoreContracts(addresses[chain]!));
    }
  }

  mustGetInbox(src: NameOrDomain, dest: NameOrDomain): Inbox {
    const contracts = this.mustGetContracts(dest);
    const srcName = this.mustGetDomain(src).name;
    return contracts.inbox(srcName);
  }
}
