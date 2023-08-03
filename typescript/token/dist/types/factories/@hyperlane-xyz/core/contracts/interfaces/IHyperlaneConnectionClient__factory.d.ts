import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IHyperlaneConnectionClient,
  IHyperlaneConnectionClientInterface,
} from '../../../../../@hyperlane-xyz/core/contracts/interfaces/IHyperlaneConnectionClient';

export declare class IHyperlaneConnectionClient__factory {
  static readonly abi: (
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
      }
  )[];
  static createInterface(): IHyperlaneConnectionClientInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IHyperlaneConnectionClient;
}
//# sourceMappingURL=IHyperlaneConnectionClient__factory.d.ts.map
