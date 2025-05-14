// ABI called by the relayer once OPL2ToL1CcipReadIsm.getOffChainVerifyInfo()
// gets executed
const OPStackServiceAbi = [
  'function getWithdrawalProof(bytes) public view returns (tuple(uint256,address,address,uint256,uint256,bytes),uint256,tuple(bytes32,bytes32,bytes32,bytes32),bytes[])',
  'function getFinalizeWithdrawalTx(bytes) public view returns (tuple(uint256,address,address,uint256,uint256,bytes))',
];

export { OPStackServiceAbi };
