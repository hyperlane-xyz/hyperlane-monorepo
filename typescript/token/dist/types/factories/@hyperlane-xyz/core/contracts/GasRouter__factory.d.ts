import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  GasRouter,
  GasRouterInterface,
} from '../../../../@hyperlane-xyz/core/contracts/GasRouter';

export declare class GasRouter__factory {
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
    | {
        inputs: {
          components: {
            internalType: string;
            name: string;
            type: string;
          }[];
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
  static createInterface(): GasRouterInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): GasRouter;
}
//# sourceMappingURL=GasRouter__factory.d.ts.map
