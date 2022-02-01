import "solidity-coverage";
import "@typechain/hardhat";
import "@nomiclabs/hardhat-etherscan";

import { task } from "hardhat/config";
import { verifyLatestCoreDeploy } from "../../typescript/optics-deploy/src/verification/verifyLatestDeploy";

import * as dotenv from "dotenv";
dotenv.config();

const etherscanKey = process.env.ETHERSCAN_API_KEY;

task(
  "verify-latest-deploy",
  "Verifies the source code of the latest contract deploy"
).setAction(async (args: any, hre: any) => {
  if (!etherscanKey) {
    throw new Error("set ETHERSCAN_API_KEY");
  }
  await verifyLatestCoreDeploy(hre, etherscanKey);
});

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.7.6",
    settings: {
      optimizer: {
        enabled: true,
        runs: 999999,
      },
    },
  },

  networks: {
    localhost: {
      url: "http://localhost:8545",
    },
    goerli: {
      url: "https://goerli.infura.io/v3/5c456d7844fa40a683e934df60534c60",
    },
    kovan: {
      url: "https://kovan.infura.io/v3/5c456d7844fa40a683e934df60534c60",
    },
    rinkeby: {
      url: "https://rinkeby.infura.io/v3/5c456d7844fa40a683e934df60534c60",
    },
    mainnet: {
      url: "https://eth-mainnet.alchemyapi.io/v2/hPY2z3xUkRrFVnUDTEA247ogtEtbszHV",
    },
    polygon: {
      url: "https://misty-divine-moon.matic.quiknode.pro/fb5067d9917063d4badbfa02afa7e69a10ec52d1/"
    },
    // To actually support avalanche, you have to go into the node_modules of the etherscan plugin and manually add it there
    avalanche: {
      url: 'https://api.avax.network/ext/bc/C/rpc'
    },
    celo: {
      url: 'https://forno.celo.org'
    },
    arbitrum_rinkeby: {
      url: "rinkeby.arbitrum.io/rpc",
    },
    // TODO: add Ropsten
  },
  typechain: {
    outDir: "../../typescript/typechain/optics-core",
    target: "ethers-v5",
    alwaysGenerateOverloads: false, // should overloads with full signatures like deposit(uint256) be generated always, even if there are no overloads?
  },
  mocha: {
    bail: true,
  },
  etherscan: {
    apiKey: etherscanKey,
  },
};
