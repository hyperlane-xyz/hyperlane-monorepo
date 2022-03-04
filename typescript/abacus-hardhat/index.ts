import '@nomiclabs/hardhat-waffle';
import { extendEnvironment } from 'hardhat/config';
import { lazyObject } from "hardhat/plugins";
import { TestCoreDeploy } from './src/abacus'


import "hardhat/types/runtime";

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: TestCoreDeploy;
  }
}

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = lazyObject(() => new TestCoreDeploy());
});
