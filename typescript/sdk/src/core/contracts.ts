import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Mailbox,
  Mailbox__factory,
  MultisigZone,
  MultisigZone__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
} from '@abacus-network/core';

import { BeaconProxyAddresses, ProxiedContract } from '../proxy';

export type MailboxContracts = {};

type ConnectionClientContracts = {
  interchainGasPaymaster: ProxiedContract<
    InterchainGasPaymaster,
    BeaconProxyAddresses
  >;
};

export type CoreContracts = ConnectionClientContracts & {
  mailbox: ProxiedContract<Mailbox, BeaconProxyAddresses>;
  defaultZone: MultisigZone;
  upgradeBeaconController: UpgradeBeaconController;
};

export const coreFactories = {
  upgradeBeaconController: new UpgradeBeaconController__factory(),
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  multisigZone: new MultisigZone__factory(),
  mailbox: new Mailbox__factory(),
};
