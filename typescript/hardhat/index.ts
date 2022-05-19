import { MultiProvider, TestChainNames } from "@abacus-network/sdk";
import '@nomiclabs/hardhat-waffle';
import { ethers } from "ethers";
import { extendEnvironment } from 'hardhat/config';
import { lazyObject } from "hardhat/plugins";
import { HardhatRuntimeEnvironment } from "hardhat/types";


import "hardhat/types/runtime";
import { TestCoreDeploy } from './src/TestCoreDeploy';

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: TestCoreDeploy;
  }
}

export function hardhatMultiProvider(hardhatEthers: HardhatRuntimeEnvironment['ethers'], signer?: ethers.Signer): MultiProvider<TestChainNames> {
  return new MultiProvider<TestChainNames>({
    test1: {
      provider: hardhatEthers.provider,
      signer
    },
    test2: {
      provider: hardhatEthers.provider,
      signer
    },
    test3: {
      provider: hardhatEthers.provider,
      signer
    }
  })
}

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = lazyObject(() => new TestCoreDeploy(hardhatMultiProvider(hre.ethers)));
});
