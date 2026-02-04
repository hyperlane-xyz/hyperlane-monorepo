import { BigNumber } from 'ethers';
import { z } from 'zod';

import { InterchainGasPaymaster } from '@hyperlane-xyz/core';
import type { Address } from '@hyperlane-xyz/utils';

import type { CheckerViolation } from '../deploy/types.js';
import { IgpSchema } from '../hook/types.js';
import { ChainMap } from '../types.js';

export type IgpConfig = z.infer<typeof IgpSchema>;

export enum IgpViolationType {
  Beneficiary = 'Beneficiary',
  GasOracles = 'GasOracles',
  Overhead = 'Overhead',
}

export interface IgpViolation extends CheckerViolation {
  type: 'InterchainGasPaymaster';
  subType: IgpViolationType;
}

export interface IgpBeneficiaryViolation extends IgpViolation {
  subType: IgpViolationType.Beneficiary;
  contract: InterchainGasPaymaster;
  actual: Address;
  expected: Address;
}

export interface IgpGasOraclesViolation extends IgpViolation {
  subType: IgpViolationType.GasOracles;
  contract: InterchainGasPaymaster;
  actual: ChainMap<Address>;
  expected: ChainMap<Address>;
}

export interface IgpOverheadViolation extends IgpViolation {
  subType: IgpViolationType.Overhead;
  contract: InterchainGasPaymaster;
  actual: ChainMap<BigNumber>;
  expected: ChainMap<BigNumber>;
}

/**
 * Represents a gas payment made for an interchain message.
 * This is parsed from GasPayment events emitted by the InterchainGasPaymaster.
 */
export interface InterchainGasPayment {
  /** The ID of the message this payment is for (bytes32 hex) */
  messageId: string;
  /** The destination domain ID */
  destination: number;
  /** Amount of destination gas paid for */
  gasAmount: bigint;
  /** Amount of native tokens paid */
  payment: bigint;
}

/**
 * Status of gas payment policy evaluation.
 */
export enum GasPolicyStatus {
  /** Gas payment meets the policy requirements */
  PolicyMet = 'PolicyMet',
  /** Gas payment does not meet the policy requirements */
  PolicyNotMet = 'PolicyNotMet',
  /** No gas payment was found for the message */
  NoPaymentFound = 'NoPaymentFound',
}
