import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IInterchainGasPaymaster,
  IInterchainGasPaymasterInterface,
} from '../../../../../@hyperlane-xyz/core/contracts/interfaces/IInterchainGasPaymaster';

export declare class IInterchainGasPaymaster__factory {
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
  static createInterface(): IInterchainGasPaymasterInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IInterchainGasPaymaster;
}
//# sourceMappingURL=IInterchainGasPaymaster__factory.d.ts.map
