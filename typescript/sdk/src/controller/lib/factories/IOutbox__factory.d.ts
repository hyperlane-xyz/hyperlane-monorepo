import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type { IOutbox, IOutboxInterface } from '../IOutbox';

export declare class IOutbox__factory {
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
  static createInterface(): IOutboxInterface;
  static connect(address: string, signerOrProvider: Signer | Provider): IOutbox;
}
//# sourceMappingURL=IOutbox__factory.d.ts.map
