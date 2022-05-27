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

import { ChainName, RemoteChainMap } from '../types';

export type InboxContracts = {
  inbox: Inbox;
  inboxValidatorManager: InboxValidatorManager;
};

export type CoreContracts<
  Networks extends ChainName,
  Local extends Networks,
> = {
  abacusConnectionManager: AbacusConnectionManager;
  upgradeBeaconController: UpgradeBeaconController;
  outbox: {
    outbox: Outbox;
    outboxValidatorManager: OutboxValidatorManager;
  };
  inboxes: RemoteChainMap<Networks, Local, InboxContracts>;
  interchainGasPaymaster: InterchainGasPaymaster;
};

export const coreFactories = {
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  outbox: new Outbox__factory(),
  outboxValidatorManager: new OutboxValidatorManager__factory(),
  inbox: new Inbox__factory(),
  inboxValidatorManager: new InboxValidatorManager__factory(),
  abacusConnectionManager: new AbacusConnectionManager__factory(),
  upgradeBeaconController: new UpgradeBeaconController__factory(),
};
