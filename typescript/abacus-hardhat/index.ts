import '@nomiclabs/hardhat-waffle';
import { ethers} from 'ethers';
import { extendEnvironment } from 'hardhat/config';
import { abc } from './src/abacus';

import { abacus, types } from '@abacus-network/abacus-deploy'
import "hardhat/types/runtime";


declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    abacus: HardhatAbacusHelpers;
  }
}

export interface HardhatAbacusHelpers {
  deploy: (domains: types.Domain[], signer: ethers.Signer) => Promise<abacus.CoreDeploy>;
}

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = abc;
});
