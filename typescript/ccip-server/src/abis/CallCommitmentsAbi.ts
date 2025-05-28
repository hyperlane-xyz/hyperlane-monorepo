// ABI called by the relayer after executing
// CommitmentReadIsm.getOffChainVerify() function as per
// CCIP-read standard
import { CommitmentReadIsmService__factory } from '@hyperlane-xyz/core';

const CallCommitmentsAbi = CommitmentReadIsmService__factory.abi;

export { CallCommitmentsAbi };
