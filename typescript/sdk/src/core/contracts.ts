import {
  Inbox,
  InboxValidatorManager,
  InboxValidatorManager__factory,
  InterchainGasPaymaster__factory,
  OutboxValidatorManager__factory,
  Outbox__factory,
} from '@abacus-network/core';
import { types } from '@abacus-network/utils';
import { AbacusRouterContracts } from '../contracts';
import { ChainName, ProxiedAddress, Remotes } from '../types';

export type CoreContractAddresses<N extends ChainName, L extends N> = {
  interchainGasPaymaster: types.Address;
  outbox: ProxiedAddress;
  outboxValidatorManager: types.Address;
} & {
  [key in Remotes<N, L> as `${key}Inbox`]: ProxiedAddress;
} & {
  [key in Remotes<N, L> as `${key}InboxValidatorManager`]: types.Address;
};

export class CoreContracts<
  N extends ChainName,
  L extends N,
> extends AbacusRouterContracts<CoreContractAddresses<N, L>> {
  get factories() {
    const inboxKeys = Object.keys(this.addresses).filter(
      (key) => key.includes('Inbox') && !key.includes('ValidatorManager'),
    );
    const inboxEntries = inboxKeys.map((key) => [
      key,
      InboxValidatorManager__factory.connect,
    ]);
    const validatorManagerKeys = inboxKeys.filter((key) =>
      key.includes('ValidatorManager'),
    );
    const validatorManagerEntries = validatorManagerKeys.map((key) => [
      key,
      InboxValidatorManager__factory.connect,
    ]);

    return {
      interchainGasPaymaster: InterchainGasPaymaster__factory.connect,
      outbox: Outbox__factory.connect,
      outboxValidatorManager: OutboxValidatorManager__factory.connect,
      ...Object.fromEntries(inboxEntries),
      ...Object.fromEntries(validatorManagerEntries),
    };
  }

  inbox(chain: Remotes<N, L>): Inbox {
    return this.contracts[`${chain}Inbox`] as Inbox;
  }

  inboxValidatorManager(chain: Remotes<N, L>): InboxValidatorManager {
    return this.contracts[
      `${chain}InboxValidatorManager`
    ] as InboxValidatorManager;
  }
}
