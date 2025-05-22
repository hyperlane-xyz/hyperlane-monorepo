// ABI called by the relayer after executing
// CommitmentReadIsm.getOffChainVerify() function as per
// CCIP-read standard
const CallCommitmentsAbi = [
  'function getCallsFromRevealMessage(bytes) public view returns (bytes memory)',
];

export { CallCommitmentsAbi };
