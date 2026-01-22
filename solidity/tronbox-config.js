module.exports = {
  compilers: {
    solc: {
      version: '0.8.22',
      settings: {
        optimizer: {
          enabled: true,
          runs: 999_999,
        },
        evmVersion: 'paris',
        debug: {
          debugInfo: [],
        },
        outputSelection: {
          '*': {
            '*': ['abi', 'evm.bytecode'],
            '': [],
          },
        },
      },
    },
  },
};
