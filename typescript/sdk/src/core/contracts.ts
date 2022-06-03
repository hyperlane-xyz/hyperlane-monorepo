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

import { BeaconProxyAddresses, ProxiedContract } from '../proxy';
import { ChainName, RemoteChainMap } from '../types';

export type InboxContracts = {
  inbox: ProxiedContract<Inbox, BeaconProxyAddresses>;
  inboxValidatorManager: InboxValidatorManager;
};

const inboxFactories = {
  inbox: new Inbox__factory(),
  inboxValidatorManager: new InboxValidatorManager__factory(),
};

export type OutboxContracts = {
  outbox: ProxiedContract<Outbox, BeaconProxyAddresses>;
  outboxValidatorManager: OutboxValidatorManager;
};

const outboxFactories = {
  outbox: new Outbox__factory(),
  outboxValidatorManager: new OutboxValidatorManager__factory(),
};

export type CoreContracts<
  Networks extends ChainName,
  Local extends Networks,
> = {
  abacusConnectionManager: AbacusConnectionManager;
  upgradeBeaconController: UpgradeBeaconController;
  interchainGasPaymaster: InterchainGasPaymaster;
  inboxes: RemoteChainMap<Networks, Local, InboxContracts>;
} & OutboxContracts;

export const coreFactories = {
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  abacusConnectionManager: new AbacusConnectionManager__factory(),
  upgradeBeaconController: new UpgradeBeaconController__factory(),
  ...inboxFactories,
  ...outboxFactories,
};
