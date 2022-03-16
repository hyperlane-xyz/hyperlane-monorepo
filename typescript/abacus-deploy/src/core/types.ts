import { types } from '@abacus-network/utils';
import { ProxiedAddress } from '../common';

export type CoreContractAddresses = {
  upgradeBeaconController: types.Address;
  xAppConnectionManager: types.Address;
  validatorManager: types.Address;
  outbox: ProxiedAddress;
  inboxes: Record<types.Domain, ProxiedAddress>;
};

export type CoreConfig = {
  validators: Record<string, types.Address>;
};
