import '@nomiclabs/hardhat-waffle';
import { extendEnvironment } from 'hardhat/config';

import { AbacusDeployment } from './AbacusDeployment';

import { bridge } from './bridge';

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = AbacusDeployment;
  hre.bridge = bridge;
});
