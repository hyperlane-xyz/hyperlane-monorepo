import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import { generateRandomNonce } from '@radixdlt/radix-engine-toolkit';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import {
  getComponentOwner,
  getComponentState,
  getFieldValueFromEntityState,
  getOptionalFieldValueFromEntityState,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { READ_ACCOUNT_HEX_PUBLIC_KEY } from '../utils/constants.js';
import { Receipt } from '../utils/types.js';

function isReceipt(value: unknown): value is Receipt {
  if (typeof value !== 'object' || value === null) return false;
  return Array.isArray(Reflect.get(value, 'output'));
}

function getBooleanOutput(value: unknown): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = Reflect.get(value, 'value');
  return typeof raw === 'boolean' ? raw : undefined;
}

export async function getMailboxConfig(
  gateway: Readonly<GatewayApiClient>,
  mailboxAddress: string,
): Promise<{
  address: string;
  owner: string;
  localDomain: number;
  nonce: number;
  defaultIsm?: string;
  defaultHook?: string;
  requiredHook?: string;
}> {
  const mailboxDetails = await getRadixComponentDetails(
    gateway,
    mailboxAddress,
    'mailbox',
  );

  const mailboxState = getComponentState(mailboxAddress, mailboxDetails);
  const owner = await getComponentOwner(
    gateway,
    mailboxAddress,
    mailboxDetails,
  );

  return {
    address: mailboxAddress,
    owner,
    localDomain: getFieldValueFromEntityState(
      'local_domain',
      mailboxAddress,
      mailboxState,
      (v) => parseInt(v, 10),
    ),
    nonce: getFieldValueFromEntityState(
      'nonce',
      mailboxAddress,
      mailboxState,
      (v) => parseInt(v, 10),
    ),
    defaultIsm: getOptionalFieldValueFromEntityState(
      'default_ism',
      mailboxState,
    ),
    defaultHook: getOptionalFieldValueFromEntityState(
      'default_hook',
      mailboxState,
    ),
    requiredHook: getOptionalFieldValueFromEntityState(
      'required_hook',
      mailboxState,
    ),
  };
}

export async function isMessageDelivered(
  gateway: Readonly<GatewayApiClient>,
  mailboxAddress: string,
  messageId: string,
): Promise<boolean> {
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
          key_hex: READ_ACCOUNT_HEX_PUBLIC_KEY,
        },
      ],
      flags: {
        use_free_credit: true,
      },
      start_epoch_inclusive: constructionMetadata.ledger_state.epoch,
      end_epoch_exclusive: constructionMetadata.ledger_state.epoch + 2,
    },
  });

  const { receipt } = response;
  assert(isReceipt(receipt), 'Unexpected transaction preview receipt shape');
  assert(!receipt.error_message, `${receipt.error_message}`);

  const output = receipt.output;
  assert(output.length, `found no output for delivered method`);
  const delivered = getBooleanOutput(output[0]?.programmatic_json);
  assert(
    delivered !== undefined,
    'Unexpected delivered() output shape from transaction preview',
  );
  return delivered;
}
