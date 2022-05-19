import { Provider, TransactionRequest } from '@ethersproject/providers';
import { ContractFactory, Overrides, Signer } from 'ethers';

import type { Version0, Version0Interface } from '../Version0';

export declare class Version0__factory extends ContractFactory {
  constructor(signer?: Signer);
  deploy(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<Version0>;
  getDeployTransaction(
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): TransactionRequest;
  attach(address: string): Version0;
  connect(signer: Signer): Version0__factory;
  static readonly bytecode =
    '0x6080604052348015600f57600080fd5b5060848061001e6000396000f3fe6080604052348015600f57600080fd5b506004361060285760003560e01c8063ffa1ad7414602d575b600080fd5b60336049565b6040805160ff9092168252519081900360200190f35b60008156fea264697066735822122063f0e097a08e3ff0079764fb072f72563170cd8acafa7c221b1fb7489af2616964736f6c63430007060033';
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
  static createInterface(): Version0Interface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): Version0;
}
//# sourceMappingURL=Version0__factory.d.ts.map
