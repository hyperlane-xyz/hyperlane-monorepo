import { BigNumberish } from 'ethers';
import { Address, ProxiedAddress } from '../types';

export type CoreContractAddresses = {
  upgradeBeaconController: Address;
  xAppConnectionManager: Address;
  validatorManager: Address;
  outbox: ProxiedAddress;
  inboxes: Record<number, ProxiedAddress>;
};

export type CoreConfig = {
  processGas: BigNumberish;
  reserveGas: BigNumberish;
  validators: Record<number, Address>;
};
