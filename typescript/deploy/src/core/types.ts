import { BigNumberish } from 'ethers';
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
  processGas: BigNumberish;
  reserveGas: BigNumberish;
  validators: Record<string, types.Address>;
};
