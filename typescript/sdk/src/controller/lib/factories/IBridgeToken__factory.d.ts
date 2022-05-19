import { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type { IBridgeToken, IBridgeTokenInterface } from '../IBridgeToken';

export declare class IBridgeToken__factory {
  static readonly abi: {
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
  }[];
  static createInterface(): IBridgeTokenInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IBridgeToken;
}
//# sourceMappingURL=IBridgeToken__factory.d.ts.map
