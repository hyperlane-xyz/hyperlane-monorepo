import '@nomiclabs/hardhat-waffle';
import { ethers} from 'ethers';
import { extendEnvironment } from 'hardhat/config';
import { types } from '@abacus-network/abacus-deploy'
import { deploy, TestAbacusDeploy } from './src/abacus'

import "hardhat/types/runtime";

export interface HardhatAbacusHelpers {
  deploy: (domains: types.Domain[], signer: ethers.Signer) => Promise<TestAbacusDeploy>;
}

const abacus: HardhatAbacusHelpers = {
  deploy,
};

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: HardhatAbacusHelpers;
  }
}

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = abacus;
});
