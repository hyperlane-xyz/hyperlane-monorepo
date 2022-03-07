import '@nomiclabs/hardhat-waffle';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.7.6",
  },
  // For some reason the BridgeRouter is oversized here but not in
  // in abacus-xapps.
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true
    }
  },
};

