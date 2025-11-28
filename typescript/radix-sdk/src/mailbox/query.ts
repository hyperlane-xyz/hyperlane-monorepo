import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  PrivateKey,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import { utils } from 'ethers';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import { EntityDetails, Receipt } from '../utils/types.js';

export async function getMailbox(
  gateway: Readonly<GatewayApiClient>,
  mailboxAddress: string,
): Promise<{
  address: string;
  owner: string;
  localDomain: number;
  nonce: number;
  defaultIsm: string;
  defaultHook: string;
  requiredHook: string;
}> {
  const details =
    await gateway.state.getEntityDetailsVaultAggregated(mailboxAddress);
  const mailboxDetails = details.details;
  assert(
    mailboxDetails?.type === 'Component',
    `Expected the provided address "${mailboxAddress}" to be a radix component`,
  );

  const fields = (mailboxDetails.state as EntityDetails['state']).fields;

  const ownerResource = (details.details as EntityDetails).role_assignments
    .owner.rule.access_rule.proof_rule.requirement.resource;

  const { items } = await gateway.extensions.getResourceHolders(ownerResource);

  const resourceHolders = [
    ...new Set(items.map((item) => item.holder_address)),
  ];

  assert(
    resourceHolders.length === 1,
    `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`,
  );

  const localDomain: string | undefined = fields.find(
    (f) => f.field_name === 'local_domain',
  )?.value;
  assert(
    localDomain,
    `Expected local_domain field to be defined on radix component at ${mailboxAddress}`,
  );

  const nonce: string | undefined = fields.find(
    (f) => f.field_name === 'nonce',
  )?.value;
  assert(
    nonce,
    `Expected nonce field to be defined on radix component at ${mailboxAddress}`,
  );

  const defaultIsmAddress: string | undefined = fields
    .find((f) => f.field_name === 'default_ism')
    ?.fields?.at(0)?.value;
  assert(
    defaultIsmAddress,
    `Expected default_ism field to be defined on radix component at ${mailboxAddress}`,
  );

  const defaultHookAddress: string | undefined = fields
    .find((f) => f.field_name === 'default_hook')
    ?.fields?.at(0)?.value;
  assert(
    defaultHookAddress,
    `Expected default_hook field to be defined on radix component at ${mailboxAddress}`,
  );

  const requiredHookAddress: string | undefined = fields
    .find((f) => f.field_name === 'required_hook')
    ?.fields?.at(0)?.value;
  assert(
    requiredHookAddress,
    `Expected required_hook field to be defined on radix component at ${mailboxAddress}`,
  );

  return {
    address: mailboxAddress,
    owner: resourceHolders[0],
    localDomain: parseInt(localDomain),
    nonce: parseInt(nonce),
    defaultIsm: defaultIsmAddress,
    defaultHook: defaultHookAddress,
    requiredHook: requiredHookAddress,
  };
}

export async function isMessageDelivered(
  gateway: Readonly<GatewayApiClient>,
  mailboxAddress: string,
  messageId: string,
): Promise<boolean> {
  const pk = new PrivateKey.Ed25519(new Uint8Array(utils.randomBytes(32)));

  const constructionMetadata =
    await gateway.transaction.innerClient.transactionConstruction();

  const response = await gateway.transaction.innerClient.transactionPreview({
    transactionPreviewRequest: {
      manifest: `
            CALL_METHOD
                Address("${mailboxAddress}")
                "delivered"
                Bytes("${strip0x(messageId)}")
            ;
        `,
      nonce: generateRandomNonce(),
      signer_public_keys: [
        {
          key_type: 'EddsaEd25519',
          key_hex: pk.publicKeyHex(),
        },
      ],
      flags: {
        use_free_credit: true,
      },
      start_epoch_inclusive: constructionMetadata.ledger_state.epoch,
      end_epoch_exclusive: constructionMetadata.ledger_state.epoch + 2,
    },
  });

  assert(
    !(response.receipt as Receipt).error_message,
    `${(response.receipt as Receipt).error_message}`,
  );

  const output = (response.receipt as Receipt).output;
  assert(output.length, `found no output for delivered method`);

  return (output[0].programmatic_json as { value: boolean }).value;
}
