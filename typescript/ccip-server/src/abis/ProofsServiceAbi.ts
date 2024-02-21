// This is the ABI for the ProofsService.
// This is used to 1) Select the function 2) encode output
const ProofsServiceAbi = [
  'function getProofs(address, bytes32, uint32) public view returns (string[][])',
];

export { ProofsServiceAbi };
