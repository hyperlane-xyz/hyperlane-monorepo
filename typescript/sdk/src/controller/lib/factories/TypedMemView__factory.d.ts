import { Provider, TransactionRequest } from '@ethersproject/providers';
import { ContractFactory, Overrides, Signer } from 'ethers';

import type { TypedMemView, TypedMemViewInterface } from '../TypedMemView';

export declare class TypedMemView__factory extends ContractFactory {
  constructor(signer?: Signer);
  deploy(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<TypedMemView>;
  getDeployTransaction(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): TransactionRequest;
  attach(address: string): TypedMemView;
  connect(signer: Signer): TypedMemView__factory;
  static readonly bytecode =
    '0x60cd610025600b82828239805160001a60731461001857fe5b30600052607381538281f3fe730000000000000000000000000000000000000000301460806040526004361060335760003560e01c8063f26be3fc146038575b600080fd5b603e6073565b604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000009092168252519081900360200190f35b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000008156fea2646970667358221220bd3a1336be4a92343defba144a797d545d17c3fc8d2f518439c63275eaf2eba264736f6c63430007060033';
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
  static createInterface(): TypedMemViewInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): TypedMemView;
}
//# sourceMappingURL=TypedMemView__factory.d.ts.map
