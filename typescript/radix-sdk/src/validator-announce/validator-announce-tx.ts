import { TransactionManifest, address } from '@radixdlt/radix-engine-toolkit';

import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS } from '../utils/types.js';

export async function getCreateValidatorAnnounceTransaction(
  base: Readonly<RadixBase>,
  hyperlanePackageDefAddress: string,
  {
    fromAddress,
    mailboxAddress,
  }: {
    fromAddress: string;
    mailboxAddress: string;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    hyperlanePackageDefAddress,
    'ValidatorAnnounce',
    INSTRUCTIONS.INSTANTIATE,
    [address(mailboxAddress)],
  );
}
