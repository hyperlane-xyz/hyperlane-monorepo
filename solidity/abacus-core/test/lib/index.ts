import "@nomiclabs/hardhat-waffle";
import { extendEnvironment } from "hardhat/config";

import { abacus } from "./core";

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = abacus;
});
