import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type { TokenRegistry, TokenRegistryInterface } from '../TokenRegistry';

export declare class TokenRegistry__factory {
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
  static createInterface(): TokenRegistryInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): TokenRegistry;
}
//# sourceMappingURL=TokenRegistry__factory.d.ts.map
