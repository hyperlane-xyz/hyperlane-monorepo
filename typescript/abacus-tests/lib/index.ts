import '@nomiclabs/hardhat-waffle';
import { extendEnvironment } from 'hardhat/config';

import { abacus } from './core';

import { bridge } from './bridge';

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = abacus;
  hre.bridge = bridge;
});
