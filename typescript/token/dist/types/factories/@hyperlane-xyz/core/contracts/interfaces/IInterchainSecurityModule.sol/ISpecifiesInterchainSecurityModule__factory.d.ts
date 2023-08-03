import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  ISpecifiesInterchainSecurityModule,
  ISpecifiesInterchainSecurityModuleInterface,
} from '../../../../../../@hyperlane-xyz/core/contracts/interfaces/IInterchainSecurityModule.sol/ISpecifiesInterchainSecurityModule';

export declare class ISpecifiesInterchainSecurityModule__factory {
  static readonly abi: {
    inputs: never[];
    name: string;
    outputs: {
      internalType: string;
      name: string;
      type: string;
    }[];
    stateMutability: string;
    type: string;
  }[];
  static createInterface(): ISpecifiesInterchainSecurityModuleInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): ISpecifiesInterchainSecurityModule;
}
//# sourceMappingURL=ISpecifiesInterchainSecurityModule__factory.d.ts.map
