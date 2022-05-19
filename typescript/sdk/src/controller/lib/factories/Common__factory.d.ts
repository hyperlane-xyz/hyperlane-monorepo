import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type { Common, CommonInterface } from '../Common';

export declare class Common__factory {
  static readonly abi: (
    | {
        anonymous: boolean;
        inputs: {
          indexed: boolean;
          internalType: string;
          name: string;
          type: string;
        }[];
        name: string;
        type: string;
        outputs?: undefined;
        stateMutability?: undefined;
      }
    | {
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
        anonymous?: undefined;
      }
  )[];
  static createInterface(): CommonInterface;
  static connect(address: string, signerOrProvider: Signer | Provider): Common;
}
//# sourceMappingURL=Common__factory.d.ts.map
