import {
  Mailbox__factory,
  ProxyAdmin__factory,
  TimelockController__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  mailbox: new Mailbox__factory(),
  timelockController: new TimelockController__factory(),
};

export type CoreFactories = typeof coreFactories;
