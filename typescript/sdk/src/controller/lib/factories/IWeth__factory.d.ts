import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type { IWeth, IWethInterface } from '../IWeth';

export declare class IWeth__factory {
  static readonly abi: {
    inputs: {
      internalType: string;
      name: string;
      type: string;
    }[];
    name: string;
    outputs: never[];
    stateMutability: string;
    type: string;
  }[];
  static createInterface(): IWethInterface;
  static connect(address: string, signerOrProvider: Signer | Provider): IWeth;
}
//# sourceMappingURL=IWeth__factory.d.ts.map
