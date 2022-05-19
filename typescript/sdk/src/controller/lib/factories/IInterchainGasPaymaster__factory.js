'use strict';
/* Autogenerated file. Do not edit manually. */
Object.defineProperty(exports, '__esModule', { value: true });
exports.IInterchainGasPaymaster__factory = void 0;
const ethers_1 = require('ethers');
const _abi = [
  {
    inputs: [
      {
        internalType: 'uint256',
        name: '_leafIndex',
        type: 'uint256',
      },
    ],
    name: 'payGasFor',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
];
class IInterchainGasPaymaster__factory {
  static createInterface() {
    return new ethers_1.utils.Interface(_abi);
  }
  static connect(address, signerOrProvider) {
    return new ethers_1.Contract(address, _abi, signerOrProvider);
  }
}
exports.IInterchainGasPaymaster__factory = IInterchainGasPaymaster__factory;
IInterchainGasPaymaster__factory.abi = _abi;
//# sourceMappingURL=IInterchainGasPaymaster__factory.js.map
