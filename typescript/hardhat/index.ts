import { MultiProvider } from "@abacus-network/sdk";
import '@nomiclabs/hardhat-waffle';
import { ethers } from "ethers";
import { extendEnvironment } from 'hardhat/config';
import { lazyObject } from "hardhat/plugins";
import { HardhatRuntimeEnvironment } from "hardhat/types";


import "hardhat/types/runtime";
import { TestCoreDeploy } from './src/TestCoreDeploy';
import { TestNetworks } from './src/types';

export { TestCoreApp } from './src/TestCoreApp';
export { TestCoreDeploy } from './src/TestCoreDeploy';

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: TestCoreDeploy;
  }
}

export function hardhatMultiProvider(ethers: HardhatRuntimeEnvironment['ethers'], signer?: ethers.Signer): MultiProvider<TestNetworks> {
  return new MultiProvider<TestNetworks>({
    test1: {
      provider: ethers.provider,
      signer
    },
    test2: {
      provider: ethers.provider,
      signer
    },
    test3: {
      provider: ethers.provider,
      signer
    }
  })
}

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = lazyObject(() => new TestCoreDeploy(hardhatMultiProvider(hre.ethers)));
});
