import '@nomiclabs/hardhat-waffle';
import { extendEnvironment } from 'hardhat/config';
import { lazyObject } from "hardhat/plugins";
import { TestAbacusDeploy } from './src/abacus'


import "hardhat/types/runtime";

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: TestAbacusDeploy;
  }
}

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = lazyObject(() => new TestAbacusDeploy());
});
