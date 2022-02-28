import "@nomiclabs/hardhat-waffle";
import { extendEnvironment } from "hardhat/config";

import { abacus } from "./core";
import { AbacusDeployment } from "./AbacusDeployment";

// HardhatRuntimeEnvironment
extendEnvironment((hre) => {
  hre.abacus = abacus;
  hre.deployment = AbacusDeployment;
});
