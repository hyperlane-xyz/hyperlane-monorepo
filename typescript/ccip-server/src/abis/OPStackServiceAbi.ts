const OPStackServiceAbi = [
  'function getWithdrawalProof(bytes) public view returns (bytes)',
  'function getFinalizeWithdrawalTx(bytes) public view returns (bytes)',
  'function identity(bytes) public view returns (bytes)', // TODO: remove
];

export { OPStackServiceAbi };
