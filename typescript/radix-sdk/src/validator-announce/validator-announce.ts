import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { TransactionManifest, address } from '@radixdlt/radix-engine-toolkit';

import {
  getComponentState,
  getFieldValueFromEntityState,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import { INSTRUCTIONS } from '../utils/types.js';

/**
 * Query functions
 */

export async function getValidatorAnnounceConfig(
  gateway: Readonly<GatewayApiClient>,
  validatorAnnounceAddress: string,
): Promise<{
  address: string;
  mailboxAddress: string;
}> {
  const validatorAnnounceDetails = await getRadixComponentDetails(
    gateway,
    validatorAnnounceAddress,
    'validator_announce',
  );

  const validatorAnnounceState = getComponentState(
    validatorAnnounceAddress,
    validatorAnnounceDetails,
  );

  return {
    address: validatorAnnounceAddress,
    mailboxAddress: getFieldValueFromEntityState(
      'mailbox',
      validatorAnnounceAddress,
      validatorAnnounceState,
    ),
  };
}

/**
 * Transaction functions
 */

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
