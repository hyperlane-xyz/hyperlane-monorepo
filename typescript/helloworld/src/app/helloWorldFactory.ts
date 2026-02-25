import { createRequire } from 'node:module';

import { ViemContractFactory } from '@hyperlane-xyz/core';
import type { Abi } from 'viem';

const require = createRequire(import.meta.url);

type HelloWorldArtifact = {
  abi: Abi;
  bytecode?: `0x${string}`;
};

const helloWorldArtifact =
  require('../../artifacts/contracts/HelloWorld.sol/HelloWorld.json') as HelloWorldArtifact;

export class HelloWorld__factory extends ViemContractFactory<
  typeof helloWorldArtifact.abi
> {
  static readonly artifact = {
    contractName: 'HelloWorld',
    abi: helloWorldArtifact.abi,
    bytecode: (helloWorldArtifact.bytecode ?? '0x') as `0x${string}`,
  };
}

export type HelloWorld = ReturnType<HelloWorld__factory['connect']>;
