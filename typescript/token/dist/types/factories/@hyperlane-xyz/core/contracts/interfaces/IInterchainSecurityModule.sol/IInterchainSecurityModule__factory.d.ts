import type { Provider } from '@ethersproject/providers';
import { Signer } from 'ethers';

import type {
  IInterchainSecurityModule,
  IInterchainSecurityModuleInterface,
} from '../../../../../../@hyperlane-xyz/core/contracts/interfaces/IInterchainSecurityModule.sol/IInterchainSecurityModule';

export declare class IInterchainSecurityModule__factory {
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
  static createInterface(): IInterchainSecurityModuleInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): IInterchainSecurityModule;
}
//# sourceMappingURL=IInterchainSecurityModule__factory.d.ts.map
