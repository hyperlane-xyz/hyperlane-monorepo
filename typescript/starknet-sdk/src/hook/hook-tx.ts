import {
  StarknetContractName,
  normalizeStarknetAddressSafe,
} from '../contracts.js';
import { type StarknetAnnotatedTx } from '../types.js';

export function getCreateMerkleTreeHookTx(
  signer: string,
  mailboxAddress: string,
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.MERKLE_TREE_HOOK,
    constructorArgs: [
      normalizeStarknetAddressSafe(mailboxAddress),
      normalizeStarknetAddressSafe(signer),
    ],
  };
}

export function getCreateNoopHookTx(): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.HOOK,
    constructorArgs: [],
  };
}
