// ABI called by the relayer after executing
// CommitmentReadIsm.getOffChainVerify() function as per
// CCIP-read standard
import { CommitmentReadIsm__factory } from '@hyperlane-xyz/core';

const CallCommitmentsAbi = CommitmentReadIsm__factory.abi;

export { CallCommitmentsAbi };
