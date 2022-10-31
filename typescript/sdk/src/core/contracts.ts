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
} from '@hyperlane-xyz/core';

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

type ConnectionClientContracts = {
  interchainGasPaymaster: ProxiedContract<
    InterchainGasPaymaster,
    BeaconProxyAddresses
  >;
  connectionManager: AbacusConnectionManager;
};

export type CoreContracts<
  Chains extends ChainName,
  Local extends Chains,
> = OutboxContracts &
  ConnectionClientContracts & {
    inboxes: RemoteChainMap<Chains, Local, InboxContracts>;
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
  connectionManager: new AbacusConnectionManager__factory(),
  upgradeBeaconController: new UpgradeBeaconController__factory(),
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  ...inboxFactories,
  ...outboxFactories,
};
