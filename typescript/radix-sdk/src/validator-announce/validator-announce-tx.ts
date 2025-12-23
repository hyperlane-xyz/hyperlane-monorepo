import { TransactionManifest, address } from '@radixdlt/radix-engine-toolkit';

import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS } from '../utils/types.js';

export async function getCreateValidatorAnnounceTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  mailboxAddress: string,
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    'ValidatorAnnounce',
    INSTRUCTIONS.INSTANTIATE,
    [address(mailboxAddress)],
  );
}
