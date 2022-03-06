import { types } from '@abacus-network/utils';
import { ChainConfig } from '../config';
import { VerificationInput } from '../verification';
import { CommonContracts } from './CommonContracts';

export abstract class CommonInstance<T extends CommonContracts<any>> {
  constructor(
    public readonly chain: ChainConfig,
    public readonly contracts: T,
  ) {}

  abstract transferOwnership(owner: types.Address): Promise<void>;
  abstract verificationInput: VerificationInput;
}
