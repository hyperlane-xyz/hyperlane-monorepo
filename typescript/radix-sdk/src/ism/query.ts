import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { assert, ensure0x, isNullish } from '@hyperlane-xyz/utils';

import { EntityDetails, MultisigIsms } from '../utils/types.js';

export async function getMultisigIsmConfig(
  gateway: Readonly<GatewayApiClient>,
  { ismAddress }: { ismAddress: string },
): Promise<{
  address: string;
  type: MultisigIsms;
  threshold: number;
  validators: string[];
}> {
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(ismAddress);
  const ismDetails = details.details;

  assert(
    ismDetails?.type === 'Component',
    `Expected the provided address "${ismAddress}" to be a component`,
  );
  assert(ismDetails.state, 'Expected state to be defined');

  const fields = (ismDetails.state as EntityDetails['state']).fields;
  const validators: any[] | undefined = fields.find(
    (f) => f.field_name === 'validators',
  )?.elements;
  assert(validators, `Expected the validators field to be defined on the `);

  const threshold: string | undefined = fields.find(
    (f) => f.field_name === 'threshold',
  )?.value;
  assert(!isNullish(threshold), `Expected threshold to be defined`);

  const result = {
    address: ismAddress,
    type: (details.details as EntityDetails).blueprint_name as MultisigIsms,
    validators: validators.map((v) => ensure0x(v.hex)),
    threshold: parseInt(threshold),
  };

  return result;
}
