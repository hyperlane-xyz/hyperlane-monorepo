import {
  Mailbox__factory,
  ProxyAdmin__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import {
  Mailbox__factory as TronMailbox__factory,
  ProxyAdmin__factory as TronProxyAdmin__factory,
  ValidatorAnnounce__factory as TronValidatorAnnounce__factory,
} from '@hyperlane-xyz/tron-sdk';

import { HyperlaneAddresses } from '../contracts/types.js';

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  mailbox: new Mailbox__factory(),
};

// Tron-compiled factories for TVM compatibility
export const tronCoreFactories = {
  validatorAnnounce: new TronValidatorAnnounce__factory(),
  proxyAdmin: new TronProxyAdmin__factory(),
  mailbox: new TronMailbox__factory(),
};

export type CoreFactories = typeof coreFactories;

export type CoreAddresses = HyperlaneAddresses<CoreFactories>;
