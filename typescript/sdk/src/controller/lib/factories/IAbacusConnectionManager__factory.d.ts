import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IAbacusConnectionManager,
  IAbacusConnectionManagerInterface,
} from '../IAbacusConnectionManager';

export declare class IAbacusConnectionManager__factory {
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
  static createInterface(): IAbacusConnectionManagerInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IAbacusConnectionManager;
}
//# sourceMappingURL=IAbacusConnectionManager__factory.d.ts.map
