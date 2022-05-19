import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type { IERC20, IERC20Interface } from '../IERC20';

export declare class IERC20__factory {
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
  static createInterface(): IERC20Interface;
  static connect(address: string, signerOrProvider: Signer | Provider): IERC20;
}
//# sourceMappingURL=IERC20__factory.d.ts.map
