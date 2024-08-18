// This is the ABI for the ProofsService.
// This is used to 1) Select the function 2) encode output
const ProofsServiceAbi = [
  'function getProofs(address target, bytes32 storageKey, bytes32 slot) public view returns (string[][])',
];

export { ProofsServiceAbi };
