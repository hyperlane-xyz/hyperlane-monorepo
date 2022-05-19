import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IValidatorManager,
  IValidatorManagerInterface,
} from '../IValidatorManager';

export declare class IValidatorManager__factory {
  static readonly abi: {
    inputs: {
      internalType: string;
      name: string;
      type: string;
    }[];
    name: string;
    outputs: {
      internalType: string;
      name: string;
      type: string;
    }[];
    stateMutability: string;
    type: string;
  }[];
  static createInterface(): IValidatorManagerInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IValidatorManager;
}
//# sourceMappingURL=IValidatorManager__factory.d.ts.map
