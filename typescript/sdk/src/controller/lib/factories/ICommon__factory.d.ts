import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type { ICommon, ICommonInterface } from '../ICommon';

export declare class ICommon__factory {
  static readonly abi: {
    inputs: never[];
    name: string;
    outputs: {
      internalType: string;
      name: string;
      type: string;
    }[];
    stateMutability: string;
    type: string;
  }[];
  static createInterface(): ICommonInterface;
  static connect(address: string, signerOrProvider: Signer | Provider): ICommon;
}
//# sourceMappingURL=ICommon__factory.d.ts.map
