import { Provider, TransactionRequest } from '@ethersproject/providers';
import { ContractFactory, Overrides, Signer } from 'ethers';

import type { TestSet, TestSetInterface } from '../TestSet';

export declare class TestSet__factory extends ContractFactory {
  constructor(signer?: Signer);
  deploy(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<TestSet>;
  getDeployTransaction(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): TransactionRequest;
  attach(address: string): TestSet;
  connect(signer: Signer): TestSet__factory;
  static readonly bytecode =
    '0x6080604052348015600f57600080fd5b5060ac8061001e6000396000f3fe6080604052348015600f57600080fd5b506004361060325760003560e01c806360fe47b11460375780636d4ce63c146053575b600080fd5b605160048036036020811015604b57600080fd5b5035606b565b005b60596070565b60408051918252519081900360200190f35b600055565b6000549056fea26469706673582212201581d5f856ea1fa0966794e26720a6a84eec20f3e0d8e7e772f402c407ef4cd064736f6c63430007060033';
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
  static createInterface(): TestSetInterface;
  static connect(address: string, signerOrProvider: Signer | Provider): TestSet;
}
//# sourceMappingURL=TestSet__factory.d.ts.map
