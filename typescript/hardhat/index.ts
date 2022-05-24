import { MultiProvider, TestChainNames } from '@abacus-network/sdk';
import '@nomiclabs/hardhat-waffle';
import { ethers } from 'ethers';
import 'hardhat/types/runtime';
import { TestCoreDeploy } from './src/TestCoreDeploy';

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: TestCoreDeploy;
  }
}

export function hardhatMultiProvider(
  signer: ethers.Signer,
): MultiProvider<TestChainNames> {
  return new MultiProvider<TestChainNames>({
    test1: {
      provider: signer.provider!,
      signer,
    },
    test2: {
      provider: signer.provider!,
      signer,
    },
    test3: {
      provider: signer.provider!,
      signer,
    },
  });
}

// HardhatRuntimeEnvironment
// extendEnvironment((hre) => {
//   hre.abacus = lazyObject(
//     () => new TestCoreDeploy(hardhatMultiProvider(hre.ethers)),
//   );
// });
