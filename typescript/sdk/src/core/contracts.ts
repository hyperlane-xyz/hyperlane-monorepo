import {
  XAppConnectionManager,
  XAppConnectionManager__factory,
} from '@abacus-network/apps';
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
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';
import { IAbacusContracts } from '../contracts';
import {
  ChainName,
  Connection,
  ProxiedAddress,
  RemoteChainSubsetMap,
  Remotes,
} from '../types';
import { objMap } from '../utils';

type MailboxAddresses = ProxiedAddress & { validatorManager: types.Address };

// Deploy/Hardhat should generate this as JSON
export type CoreContractAddresses<N extends ChainName, L extends N> = {
  xAppConnectionManager: types.Address;
  interchainGasPaymaster: types.Address;
  outbox: MailboxAddresses;
  inboxes: RemoteChainSubsetMap<N, L, MailboxAddresses>;
};

type InboxContracts = {
  inbox: Inbox;
  validatorManager: InboxValidatorManager;
};

type OutboxContracts = {
  outbox: Outbox;
  validatorManager: OutboxValidatorManager;
};

type CoreContractSchema<N extends ChainName, L extends N> = {
  xAppConnectionManager: XAppConnectionManager;
  outbox: OutboxContracts;
  inboxes: RemoteChainSubsetMap<N, L, InboxContracts>;
  interchainGasPaymaster: InterchainGasPaymaster;
};

export const coreFactories = {
  interchainGasPaymaster: InterchainGasPaymaster__factory.connect,
  outbox: Outbox__factory.connect,
  outboxValidatorManager: OutboxValidatorManager__factory.connect,
  inbox: Inbox__factory.connect,
  inboxValidatorManager: InboxValidatorManager__factory.connect,
  xAppConnectionManager: XAppConnectionManager__factory.connect,
};

export class CoreContracts<N extends ChainName = ChainName, L extends N = N>
  implements IAbacusContracts<CoreContractSchema<N, L>>
{
  contracts: CoreContractSchema<N, L>;

  constructor(addresses: CoreContractAddresses<N, L>, connection: Connection) {
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
      xAppConnectionManager: factories.xAppConnectionManager(
        addresses.xAppConnectionManager,
        connection,
      ),
    };
  }

  reconnect(connection: Connection) {
    this.contracts.outbox.outbox.connect(connection);
    this.contracts.outbox.validatorManager.connect(connection);
    this.contracts.interchainGasPaymaster.connect(connection);
    this.contracts.xAppConnectionManager.connect(connection);
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
