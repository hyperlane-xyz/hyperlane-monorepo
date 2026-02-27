import { createRequire } from 'node:module';

import type { Router } from '@hyperlane-xyz/core';
import {
  ContractWriteResult,
  RunnerLike,
  ViemContractFactory,
} from '@hyperlane-xyz/core';
import type { Abi } from 'viem';

const require = createRequire(import.meta.url);

type HelloWorldArtifact = {
  abi: Abi;
  bytecode?: `0x${string}`;
};

const helloWorldArtifact =
  require('../../artifacts/contracts/HelloWorld.sol/HelloWorld.json') as HelloWorldArtifact;

type HelloWorldEstimateGas = {
  sendHelloWorld(
    destination: number,
    message: string,
    overrides?: Record<string, unknown>,
  ): Promise<bigint>;
};

export type HelloWorld = Router & {
  quoteDispatch(
    destination: number,
    message: string | Uint8Array,
    overrides?: Record<string, unknown>,
  ): Promise<bigint>;
  'quoteDispatch(uint32,bytes)'(
    destination: number,
    message: string | Uint8Array,
    overrides?: Record<string, unknown>,
  ): Promise<bigint>;
  sendHelloWorld(
    destination: number,
    message: string,
    overrides?: Record<string, unknown>,
  ): Promise<ContractWriteResult>;
  sentTo(destination: number): Promise<bigint>;
  receivedFrom(origin: number): Promise<bigint>;
  estimateGas: Router['estimateGas'] & HelloWorldEstimateGas;
};

export class HelloWorld__factory extends ViemContractFactory<
  typeof helloWorldArtifact.abi,
  HelloWorld
> {
  static readonly artifact = {
    contractName: 'HelloWorld',
    abi: helloWorldArtifact.abi,
    bytecode: (helloWorldArtifact.bytecode ?? '0x') as `0x${string}`,
  };

  static override connect(address: string, runner?: RunnerLike): HelloWorld {
    return super.connect(address, runner) as HelloWorld;
  }
}
