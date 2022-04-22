import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
  OutboxValidatorManager,
  OutboxValidatorManager__factory,
  InboxValidatorManager,
  InboxValidatorManager__factory,
  Outbox,
  Outbox__factory,
  Inbox,
  Inbox__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { AbacusAppContracts } from '../contracts';
import { ChainName, ProxiedAddress } from '../types';

export type CoreContractAddresses = {
  upgradeBeaconController: types.Address;
  abacusConnectionManager: types.Address;
  interchainGasPaymaster: types.Address;
  outbox: ProxiedAddress;
  inboxes: Partial<Record<ChainName, ProxiedAddress>>;
  outboxValidatorManager: types.Address;
  inboxValidatorManagers: Partial<Record<ChainName, types.Address>>;
};

export class CoreContracts extends AbacusAppContracts<CoreContractAddresses> {
  inbox(chain: ChainName): Inbox {
    const inbox = this.addresses.inboxes[chain];
    if (!inbox) {
      throw new Error(`No inbox for ${chain}`);
    }
    return Inbox__factory.connect(inbox.proxy, this.connection);
  }

  inboxValidatorManager(chain: ChainName): InboxValidatorManager {
    const inboxValidatorManager = this.addresses.inboxValidatorManagers[chain];
    if (!inboxValidatorManager) {
      throw new Error(`No inboxValidatorManager for ${chain}`);
    }
    return InboxValidatorManager__factory.connect(
      inboxValidatorManager,
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
      this.addresses.outboxValidatorManager,
      this.connection,
    );
  }

  get upgradeBeaconController(): UpgradeBeaconController {
    return UpgradeBeaconController__factory.connect(
      this.addresses.upgradeBeaconController,
      this.connection,
    );
  }

  get abacusConnectionManager(): AbacusConnectionManager {
    return AbacusConnectionManager__factory.connect(
      this.addresses.abacusConnectionManager,
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
