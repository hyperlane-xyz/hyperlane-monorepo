import "@nomicfoundation/hardhat-foundry";
import "@nomiclabs/hardhat-ethers";
import "hardhat-gas-reporter";
import "hardhat-ignore-warnings";
import "solidity-coverage";

import {rootHardhatConfig} from "./rootHardhatConfig.cjs";

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
    ...rootHardhatConfig,
    gasReporter: {
        currency: "USD",
    },
};
