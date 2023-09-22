import {
  Mailbox__factory,
  ProxyAdmin__factory,
  TimelockController__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  mailbox: new Mailbox__factory(),
  timelockController: new TimelockController__factory(),
};

export type CoreAddresses = {
  validatorAnnounce: Address;
  proxyAdmin: Address;
  mailbox: Address;
  timelockController?: Address;
};

export type CoreFactories = typeof coreFactories;
