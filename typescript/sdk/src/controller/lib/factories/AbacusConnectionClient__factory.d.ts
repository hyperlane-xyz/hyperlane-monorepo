import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  AbacusConnectionClient,
  AbacusConnectionClientInterface,
} from '../AbacusConnectionClient';

export declare class AbacusConnectionClient__factory {
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
        inputs: never[];
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
    | {
        inputs: {
          internalType: string;
          name: string;
          type: string;
        }[];
        name: string;
        outputs: never[];
        stateMutability: string;
        type: string;
        anonymous?: undefined;
      }
  )[];
  static createInterface(): AbacusConnectionClientInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): AbacusConnectionClient;
}
//# sourceMappingURL=AbacusConnectionClient__factory.d.ts.map
