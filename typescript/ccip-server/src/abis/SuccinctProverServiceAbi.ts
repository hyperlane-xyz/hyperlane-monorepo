// This is the ABI for the SuccinctProverService.
// This is used to 1) Select the function 2) encode output
const SuccinctProverServiceAbi = [
  'function getProofs(address, bytes32[], bytes) public view returns (string[][])',
];

export { SuccinctProverServiceAbi };
