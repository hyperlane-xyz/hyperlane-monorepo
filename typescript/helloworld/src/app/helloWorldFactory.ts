import { createRequire } from 'node:module';

import * as CoreContracts from '@hyperlane-xyz/core';

const require = createRequire(import.meta.url);
const ViemContractFactoryBase = (CoreContracts as any).ViemContractFactory;

type HelloWorldArtifact = {
  abi: readonly unknown[];
  bytecode?: `0x${string}`;
};

const helloWorldArtifact =
  require('../../artifacts/contracts/HelloWorld.sol/HelloWorld.json') as HelloWorldArtifact;

export type HelloWorld = any;

export class HelloWorld__factory extends ViemContractFactoryBase {
  static readonly artifact = {
    contractName: 'HelloWorld',
    abi: helloWorldArtifact.abi as any,
    bytecode: (helloWorldArtifact.bytecode ?? '0x') as `0x${string}`,
  };
}
