import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  getComponentState,
  getFieldValueFromEntityState,
  getRadixComponentDetails,
} from '../utils/base-query.js';

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
