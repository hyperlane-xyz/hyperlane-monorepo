import {
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  Mailbox,
  Mailbox__factory,
  MultisigIsm,
  MultisigIsm__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
} from '@hyperlane-xyz/core';

import { BeaconProxyAddresses, ProxiedContract } from '../proxy';

type ConnectionClientContracts = {
  interchainGasPaymaster: ProxiedContract<
    InterchainGasPaymaster,
    BeaconProxyAddresses
  >;
};

export type CoreContracts = ConnectionClientContracts & {
  mailbox: ProxiedContract<Mailbox, BeaconProxyAddresses>;
  multisigIsm: MultisigIsm;
  upgradeBeaconController: UpgradeBeaconController;
};

export const coreFactories = {
  upgradeBeaconController: new UpgradeBeaconController__factory(),
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  multisigIsm: new MultisigIsm__factory(),
  mailbox: new Mailbox__factory(),
};
