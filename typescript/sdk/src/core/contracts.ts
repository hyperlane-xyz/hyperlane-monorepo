import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Mailbox,
  Mailbox__factory,
  MultisigModule,
  MultisigModule__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
} from '@hyperlane-xyz/core';

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
  defaultModule: MultisigModule;
  upgradeBeaconController: UpgradeBeaconController;
};

export const coreFactories = {
  upgradeBeaconController: new UpgradeBeaconController__factory(),
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  multisigModule: new MultisigModule__factory(),
  mailbox: new Mailbox__factory(),
};
