import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IMailbox,
  IMailboxInterface,
} from '../../../../../@hyperlane-xyz/core/contracts/interfaces/IMailbox';

export declare class IMailbox__factory {
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
  static createInterface(): IMailboxInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IMailbox;
}
//# sourceMappingURL=IMailbox__factory.d.ts.map
