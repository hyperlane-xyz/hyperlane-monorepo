import {
  Create2Factory__factory,
  InterchainAccountRouter__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  InterchainQueryRouter__factory,
  Mailbox,
  Mailbox__factory,
  MultisigIsm,
  MultisigIsm__factory,
  OverheadIgp,
  OverheadIgp__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
  TestRecipient__factory,
  ValidatorAnnounce,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { ProxiedContract, TransparentProxyAddresses } from '../proxy';

export type ConnectionClientContracts = {
  interchainGasPaymaster: ProxiedContract<
    InterchainGasPaymaster,
    TransparentProxyAddresses
  >;
  defaultIsmInterchainGasPaymaster: OverheadIgp;
};

export type CoreContracts = ConnectionClientContracts & {
  mailbox: ProxiedContract<Mailbox, TransparentProxyAddresses>;
  multisigIsm: MultisigIsm;
  proxyAdmin: ProxyAdmin;
  validatorAnnounce: ValidatorAnnounce;
};

export type CoreContractAddresses = {
  mailbox: types.Address | TransparentProxyAddresses;
  multisigIsm: types.Address;
  interchainGasPaymaster: types.Address | TransparentProxyAddresses;
  validatorAnnounce: types.Address;
  proxyAdmin: types.Address;
  defaultIsmInterchainGasPaymaster: types.Address;
};

export const coreFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
  interchainQueryRouter: new InterchainQueryRouter__factory(),
  validatorAnnounce: new ValidatorAnnounce__factory(),
  create2Factory: new Create2Factory__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  defaultIsmInterchainGasPaymaster: new OverheadIgp__factory(),
  multisigIsm: new MultisigIsm__factory(),
  mailbox: new Mailbox__factory(),
  testRecipient: new TestRecipient__factory(),
};

type ShapeOf<T> = Record<keyof T, any>;
type AssertKeysEqual<X extends ShapeOf<Y>, Y extends ShapeOf<X>> = never;
type AssertKeysSubset<Y, X extends ShapeOf<Y>> = never;
export type AssertionA = AssertKeysEqual<CoreContracts, CoreContractAddresses>;
export type AssertionB = AssertKeysSubset<CoreContracts, typeof coreFactories>;
