import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  PrivateKey,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import { utils } from 'ethers';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import {
  getComponentOwner,
  getComponentState,
  getFieldValueFromEntityState,
  isRadixComponent,
} from '../utils/query.js';
import { Receipt } from '../utils/types.js';

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
    isRadixComponent(mailboxDetails),
    `Expected on chain details to be defined for radix mailbox at address ${mailboxAddress}`,
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
      parseInt,
    ),
    nonce: getFieldValueFromEntityState(
      'nonce',
      mailboxAddress,
      mailboxState,
      parseInt,
    ),
    defaultIsm: getFieldValueFromEntityState(
      'default_ism',
      mailboxAddress,
      mailboxState,
    ),
    defaultHook: getFieldValueFromEntityState(
      'default_hook',
      mailboxAddress,
      mailboxState,
    ),
    requiredHook: getFieldValueFromEntityState(
      'required_hook',
      mailboxAddress,
      mailboxState,
    ),
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
