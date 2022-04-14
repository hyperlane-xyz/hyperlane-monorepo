import { Inbox, InboxValidatorManager } from '@abacus-network/core';
import { AbacusApp } from '../app';
import { CoreDeployedNetworks } from '../core/environments';
import { Remotes } from '../types';
import { CoreContractAddresses, CoreContracts } from './contracts';

export class AbacusCore extends AbacusApp<
  CoreDeployedNetworks,
  CoreContractAddresses<CoreDeployedNetworks, any>,
  CoreContracts<CoreDeployedNetworks, any>
> {
  buildContracts<Local extends CoreDeployedNetworks>(
    addresses: CoreContractAddresses<CoreDeployedNetworks, Local>,
  ) {
    return new CoreContracts<CoreDeployedNetworks, Local>(addresses);
  }

  mustGetInbox<Local extends CoreDeployedNetworks>(
    src: number | Remotes<CoreDeployedNetworks, Local>,
    dest: number | Local,
  ): Inbox {
    const contracts: CoreContracts<CoreDeployedNetworks, Local> =
      this.mustGetContracts(dest);
    const srcName =
      typeof src === 'number' ? this.mustGetDomain(src).name : src;
    return contracts.inbox(srcName as any);
  }

  mustGetInboxValidatorManager<Local extends CoreDeployedNetworks>(
    src: number | Remotes<CoreDeployedNetworks, Local>,
    dest: number | Local,
  ): InboxValidatorManager {
    const contracts: CoreContracts<CoreDeployedNetworks, Local> =
      this.mustGetContracts(dest);
    const srcName =
      typeof src === 'number' ? this.mustGetDomain(src).name : src;
    return contracts.inboxValidatorManager(srcName as any);
  }
}
