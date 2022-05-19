import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IXAppConnectionManager,
  IXAppConnectionManagerInterface,
} from '../IXAppConnectionManager';

export declare class IXAppConnectionManager__factory {
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
  static createInterface(): IXAppConnectionManagerInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IXAppConnectionManager;
}
//# sourceMappingURL=IXAppConnectionManager__factory.d.ts.map
