import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IMessageRecipient,
  IMessageRecipientInterface,
} from '../IMessageRecipient';

export declare class IMessageRecipient__factory {
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
  static createInterface(): IMessageRecipientInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IMessageRecipient;
}
//# sourceMappingURL=IMessageRecipient__factory.d.ts.map
