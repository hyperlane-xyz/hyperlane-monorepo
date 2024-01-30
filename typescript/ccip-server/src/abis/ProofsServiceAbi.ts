// This is the ABI for the SuccinctProverService.
// This is used to 1) Select the function 2) encode output
const ProofsServiceAbi = [
  'function getProofs(address, bytes32[], bytes) public view returns (string[][])',
];

export { ProofsServiceAbi };
