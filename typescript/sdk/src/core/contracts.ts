import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
  Inbox,
  InboxValidatorManager,
  InboxValidatorManager__factory,
  Inbox__factory,
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

export type OutboxContracts = {
  outbox: ProxiedContract<Outbox, BeaconProxyAddresses>;
  outboxValidatorManager: OutboxValidatorManager;
};

export type CoreContracts<
  Networks extends ChainName,
  Local extends Networks,
> = OutboxContracts & {
  inboxes: RemoteChainMap<Networks, Local, InboxContracts>;
  abacusConnectionManager: AbacusConnectionManager;
  upgradeBeaconController: UpgradeBeaconController;
};

const inboxFactories = {
  inbox: new Inbox__factory(),
  inboxValidatorManager: new InboxValidatorManager__factory(),
};

const outboxFactories = {
  outbox: new Outbox__factory(),
  outboxValidatorManager: new OutboxValidatorManager__factory(),
};

export const coreFactories = {
  abacusConnectionManager: new AbacusConnectionManager__factory(),
  upgradeBeaconController: new UpgradeBeaconController__factory(),
  ...inboxFactories,
  ...outboxFactories,
};
