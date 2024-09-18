import {
  Mailbox__factory,
  ProxyAdmin__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import {
  Mailbox__artifact,
  ProxyAdmin__artifact,
  ValidatorAnnounce__artifact,
} from '@hyperlane-xyz/core/artifacts';

import { HyperlaneAddresses } from '../contracts/types.js';

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  mailbox: new Mailbox__factory(),
};

export const coreFactoriesArtifacts = {
  validatorAnnounce: ValidatorAnnounce__artifact,
  proxyAdmin: ProxyAdmin__artifact,
  mailbox: Mailbox__artifact,
};

export type CoreFactories = typeof coreFactories;

export type CoreAddresses = HyperlaneAddresses<CoreFactories>;
