import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
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
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { IAbacusContracts } from '../contracts';
import {
  ChainName,
  Connection,
  ProxiedAddress,
  RemoteChainMap,
  Remotes,
} from '../types';
import { objMap } from '../utils';

export type MailboxAddresses = ProxiedAddress & {
  validatorManager: types.Address;
};

export type CoreContractAddresses<N extends ChainName, L extends N> = {
  upgradeBeaconController: types.Address;
  abacusConnectionManager: types.Address;
  interchainGasPaymaster: types.Address;
  outbox: MailboxAddresses;
  inboxes: RemoteChainMap<N, L, MailboxAddresses>;
};

export type InboxContracts = {
  inbox: Inbox;
  validatorManager: InboxValidatorManager;
};

export type CoreContractSchema<N extends ChainName, L extends N> = {
  abacusConnectionManager: AbacusConnectionManager;
  upgradeBeaconController: UpgradeBeaconController;
  outbox: {
    outbox: Outbox;
    validatorManager: OutboxValidatorManager;
  };
  inboxes: RemoteChainMap<N, L, InboxContracts>;
  interchainGasPaymaster: InterchainGasPaymaster;
};

export const coreFactories = {
  interchainGasPaymaster: InterchainGasPaymaster__factory.connect,
  outbox: Outbox__factory.connect,
  outboxValidatorManager: OutboxValidatorManager__factory.connect,
  inbox: Inbox__factory.connect,
  inboxValidatorManager: InboxValidatorManager__factory.connect,
  abacusConnectionManager: AbacusConnectionManager__factory.connect,
  upgradeBeaconController: UpgradeBeaconController__factory.connect,
};

// TODO: extend AbacusContracts for more generic behavior
export class CoreContracts<N extends ChainName = ChainName, L extends N = N>
  implements
    IAbacusContracts<CoreContractAddresses<N, L>, CoreContractSchema<N, L>>
{
  readonly contracts: CoreContractSchema<N, L>;

  constructor(
    readonly addresses: CoreContractAddresses<N, L>,
    connection: Connection,
  ) {
    const factories = coreFactories;
    this.contracts = {
      outbox: {
        outbox: factories.outbox(addresses.outbox.proxy, connection),
        validatorManager: factories.outboxValidatorManager(
          addresses.outbox.validatorManager,
          connection,
        ),
      },
      inboxes: objMap(addresses.inboxes, (_, mailboxAddresses) => ({
        inbox: factories.inbox(mailboxAddresses.proxy, connection),
        validatorManager: factories.inboxValidatorManager(
          mailboxAddresses.validatorManager,
          connection,
        ),
      })),
      interchainGasPaymaster: factories.interchainGasPaymaster(
        addresses.interchainGasPaymaster,
        connection,
      ),
      abacusConnectionManager: factories.abacusConnectionManager(
        addresses.abacusConnectionManager,
        connection,
      ),
      upgradeBeaconController: factories.upgradeBeaconController(
        addresses.upgradeBeaconController,
        connection,
      ),
    };
  }

  reconnect(connection: Connection) {
    this.contracts.outbox.outbox.connect(connection);
    this.contracts.outbox.validatorManager.connect(connection);
    this.contracts.interchainGasPaymaster.connect(connection);
    this.contracts.abacusConnectionManager.connect(connection);
    this.contracts.upgradeBeaconController.connect(connection);
    objMap(this.contracts.inboxes, (_, inboxContracts) => {
      inboxContracts.inbox.connect(connection);
      inboxContracts.validatorManager.connect(connection);
    });
  }

  getOutbox = () => this.contracts.outbox.outbox;

  getOutboxValidatorManager = () => this.contracts.outbox.validatorManager;

  getInbox = (chain: Remotes<N, L>) => this.contracts.inboxes[chain].inbox;

  getInboxValidatorManager = (chain: Remotes<N, L>) =>
    this.contracts.inboxes[chain].validatorManager;
}
