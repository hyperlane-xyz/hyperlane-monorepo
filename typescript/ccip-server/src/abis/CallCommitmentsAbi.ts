// ABI called by the relayer after executing
// CommitmentReadIsm.getOffChainVerify() function as per
// CCIP-read standard
const CallCommitmentsAbi = [
  'function getCallsFromCommitment(bytes32) public view returns (bytes memory)',
];

export { CallCommitmentsAbi };
