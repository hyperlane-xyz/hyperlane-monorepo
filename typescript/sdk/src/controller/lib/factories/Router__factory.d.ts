import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type { Router, RouterInterface } from '../Router';

export declare class Router__factory {
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
  static createInterface(): RouterInterface;
  static connect(address: string, signerOrProvider: Signer | Provider): Router;
}
//# sourceMappingURL=Router__factory.d.ts.map
