import { Provider, TransactionRequest } from '@ethersproject/providers';
import { ContractFactory, Overrides, Signer } from 'ethers';

import type {
  PingPongRouter,
  PingPongRouterInterface,
} from '../PingPongRouter';

export declare class PingPongRouter__factory extends ContractFactory {
  constructor(signer?: Signer);
  deploy(
    _abacusConnectionManager: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): Promise<PingPongRouter>;
  getDeployTransaction(
    _abacusConnectionManager: string,
    overrides?: Overrides & {
      from?: string | Promise<string>;
    },
  ): TransactionRequest;
  attach(address: string): PingPongRouter;
  connect(signer: Signer): PingPongRouter__factory;
  static readonly bytecode =
    '0x608060405234801561001057600080fd5b5060405161008f38038061008f8339818101604052602081101561003357600080fd5b505160405162461bcd60e51b815260040180806020018281038252602281526020018061006d6022913960400191505060405180910390fdfe6578616d706c65206170706c69636174696f6e2c20646f206e6f74206465706c6f79';
  static readonly abi: (
    | {
        inputs: {
          internalType: string;
          name: string;
          type: string;
        }[];
        stateMutability: string;
        type: string;
        anonymous?: undefined;
        name?: undefined;
        outputs?: undefined;
      }
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
        stateMutability?: undefined;
        outputs?: undefined;
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
  static createInterface(): PingPongRouterInterface;
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): PingPongRouter;
}
//# sourceMappingURL=PingPongRouter__factory.d.ts.map
