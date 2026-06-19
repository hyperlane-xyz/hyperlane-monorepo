import {
  Mailbox__factory,
  ProxyAdmin__factory,
  QuotedCalls__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneAddresses } from '../contracts/types.js';

// Canonical Permit2 deployment address (same on all EVM chains)
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const requiredCoreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  mailbox: new Mailbox__factory(),
};

export const coreFactories: typeof requiredCoreFactories & {
  quotedCalls?: QuotedCalls__factory;
} = {
  ...requiredCoreFactories,
  quotedCalls: new QuotedCalls__factory(),
};

export type CoreFactories = typeof coreFactories;

export type CoreAddresses = HyperlaneAddresses<CoreFactories>;
