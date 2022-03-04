import '@nomiclabs/hardhat-waffle';
import { extendEnvironment } from 'hardhat/config';
import { abc } from './src/abacus';

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = abc;
});
