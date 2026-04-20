import {
  Mailbox__factory,
  ProxyAdmin__factory,
  QuotedCalls__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneAddresses } from '../contracts/types.js';

// Canonical Permit2 deployment address (same on all EVM chains)
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  mailbox: new Mailbox__factory(),
  quotedCalls: new QuotedCalls__factory(),
};

export type CoreFactories = typeof coreFactories;

export type CoreAddresses = HyperlaneAddresses<CoreFactories>;
