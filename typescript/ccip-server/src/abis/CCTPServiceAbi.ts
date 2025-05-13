// ABI called by the relayer after executing
// CctpIsm.getOffChainVerify() function as per
// CCIP-read standard
const CCTPServiceAbi = [
  'function getCCTPAttestation(bytes) public view returns (bytes memory, bytes memory)',
];

export { CCTPServiceAbi };
