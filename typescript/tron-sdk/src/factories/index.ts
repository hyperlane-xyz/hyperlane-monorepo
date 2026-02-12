// Re-export all typechain types and factories (flattened).
// These factories are generated from the same Solidity source as @hyperlane-xyz/core
// via the tron-solc compiler. They have identical ABIs and deploy signatures, differing
// only in bytecode (TVM-compiled with 0x41 Create2 prefix). This 1:1 correspondence
// with core factory class names is relied upon by the SDK's MultiProvider.handleDeploy
// to dynamically resolve the correct factory at deploy time.
export * from '../typechain/index.js';
