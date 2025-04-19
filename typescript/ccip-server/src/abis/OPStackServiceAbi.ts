const OPStackServiceAbi = [
  'function getWithdrawalProof(bytes) public view returns (tuple(uint256,address,address,uint256,uint256,bytes),uint256,tuple(bytes32,bytes32,bytes32,bytes32),bytes[])',
  'function getFinalizeWithdrawalTx(bytes) public view returns (tuple(uint256,address,address,uint256,uint256,bytes))',
];

export { OPStackServiceAbi };
