import {
  StarknetContractName,
  normalizeStarknetAddressSafe,
} from '../contracts.js';
import { type StarknetAnnotatedTx } from '../types.js';

export function getCreateValidatorAnnounceTx(
  signer: string,
  mailboxAddress: string,
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.VALIDATOR_ANNOUNCE,
    constructorArgs: [
      normalizeStarknetAddressSafe(mailboxAddress),
      normalizeStarknetAddressSafe(signer),
    ],
  };
}
