import {
  Mailbox__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  mailbox: new Mailbox__factory(),
};

export type CoreFactories = typeof coreFactories;
