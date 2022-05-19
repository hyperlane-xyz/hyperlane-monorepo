'use strict';
/* Autogenerated file. Do not edit manually. */
Object.defineProperty(exports, '__esModule', { value: true });
exports.ICommon__factory = void 0;
const ethers_1 = require('ethers');
const _abi = [
  {
    inputs: [],
    name: 'latestCheckpoint',
    outputs: [
      {
        internalType: 'bytes32',
        name: 'root',
        type: 'bytes32',
      },
      {
        internalType: 'uint256',
        name: 'index',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'localDomain',
    outputs: [
      {
        internalType: 'uint32',
        name: '',
        type: 'uint32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];
class ICommon__factory {
  static createInterface() {
    return new ethers_1.utils.Interface(_abi);
  }
  static connect(address, signerOrProvider) {
    return new ethers_1.Contract(address, _abi, signerOrProvider);
  }
}
exports.ICommon__factory = ICommon__factory;
ICommon__factory.abi = _abi;
//# sourceMappingURL=ICommon__factory.js.map
