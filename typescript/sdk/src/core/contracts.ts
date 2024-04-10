import {
  Mailbox__factory,
  ProxyAdmin__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneAddresses } from '../contracts/types.js';

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  mailbox: new Mailbox__factory(),
};

export type CoreFactories = typeof coreFactories;

export type CoreAddresses = HyperlaneAddresses<CoreFactories>;
