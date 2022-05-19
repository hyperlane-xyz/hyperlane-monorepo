import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IInterchainGasPaymaster,
  IInterchainGasPaymasterInterface,
} from '../IInterchainGasPaymaster';

export declare class IInterchainGasPaymaster__factory {
  static readonly abi: {
    inputs: {
      internalType: string;
      name: string;
      type: string;
    }[];
    name: string;
    outputs: never[];
    stateMutability: string;
    type: string;
  }[];
  static createInterface(): IInterchainGasPaymasterInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IInterchainGasPaymaster;
}
//# sourceMappingURL=IInterchainGasPaymaster__factory.d.ts.map
