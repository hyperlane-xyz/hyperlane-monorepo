import {
  Inbox,
  InboxValidatorManager,
  InboxValidatorManager__factory,
  Inbox__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Outbox,
  OutboxValidatorManager,
  OutboxValidatorManager__factory,
  Outbox__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  XAppConnectionManager,
  XAppConnectionManager__factory,
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';
import { AbacusAppContracts } from '../contracts';
import {
  ChainName,
  ProxiedAddress,
  RemoteChainSubsetMap,
  Remotes,
} from '../types';

type Mailbox = ProxiedAddress & { validatorManager: types.Address };

export type CoreContractAddresses<
  Networks extends ChainName,
  Local extends Networks,
> = {
  upgradeBeaconController: types.Address;
  xAppConnectionManager: types.Address;
  interchainGasPaymaster: types.Address;
  outbox: Mailbox;
  inboxes: RemoteChainSubsetMap<Networks, Local, Mailbox>;
};

export class CoreContracts<
  N extends ChainName,
  L extends N,
> extends AbacusAppContracts<CoreContractAddresses<N, L>> {
  inbox(chain: Remotes<N, L>): Inbox {
    const inbox = this.addresses.inboxes[chain];
    return Inbox__factory.connect(inbox.proxy, this.connection);
  }

  inboxValidatorManager(chain: Remotes<N, L>): InboxValidatorManager {
    const inbox = this.addresses.inboxes[chain];
    return InboxValidatorManager__factory.connect(
      inbox.validatorManager,
      this.connection,
    );
  }

  get outbox(): Outbox {
    return Outbox__factory.connect(
      this.addresses.outbox.proxy,
      this.connection,
    );
  }

  get outboxValidatorManager(): OutboxValidatorManager {
    return OutboxValidatorManager__factory.connect(
      this.addresses.outbox.validatorManager,
      this.connection,
    );
  }

  get upgradeBeaconController(): UpgradeBeaconController {
    return UpgradeBeaconController__factory.connect(
      this.addresses.upgradeBeaconController,
      this.connection,
    );
  }

  get xAppConnectionManager(): XAppConnectionManager {
    return XAppConnectionManager__factory.connect(
      this.addresses.xAppConnectionManager,
      this.connection,
    );
  }

  get interchainGasPaymaster(): InterchainGasPaymaster {
    return InterchainGasPaymaster__factory.connect(
      this.addresses.interchainGasPaymaster,
      this.connection,
    );
  }
}
