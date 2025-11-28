import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  PrivateKey,
  generateRandomNonce,
} from '@radixdlt/radix-engine-toolkit';
import { utils } from 'ethers';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { EntityDetails, Hooks, Isms, Receipt } from '../utils/types.js';

export class RadixCoreQuery {
  protected networkId: number;
  protected gateway: GatewayApiClient;
  protected base: RadixBase;

  constructor(networkId: number, gateway: GatewayApiClient, base: RadixBase) {
    this.networkId = networkId;
    this.gateway = gateway;
    this.base = base;
  }

  public async getMailbox({ mailbox }: { mailbox: string }): Promise<{
    address: string;
    owner: string;
    localDomain: number;
    nonce: number;
    defaultIsm: string;
    defaultHook: string;
    requiredHook: string;
  }> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(mailbox);
    const fields = (details.details as EntityDetails).state.fields;

    const ownerResource = (details.details as EntityDetails).role_assignments
      .owner.rule.access_rule.proof_rule.requirement.resource;

    const { items } =
      await this.gateway.extensions.getResourceHolders(ownerResource);

    const resourceHolders = [
      ...new Set(items.map((item) => item.holder_address)),
    ];

    assert(
      resourceHolders.length === 1,
      `expected token holders of resource ${ownerResource} to be one, found ${resourceHolders.length} holders instead`,
    );

    const result = {
      address: mailbox,
      owner: resourceHolders[0],
      localDomain: parseInt(
        fields.find((f) => f.field_name === 'local_domain')?.value ?? '0',
      ),
      nonce: parseInt(
        fields.find((f) => f.field_name === 'nonce')?.value ?? '0',
      ),
      defaultIsm:
        fields.find((f) => f.field_name === 'default_ism')?.fields?.at(0)
          ?.value ?? '',
      defaultHook:
        fields.find((f) => f.field_name === 'default_hook')?.fields?.at(0)
          ?.value ?? '',
      requiredHook:
        fields.find((f) => f.field_name === 'required_hook')?.fields?.at(0)
          ?.value ?? '',
    };

    return result;
  }

  public async isMessageDelivered({
    mailbox,
    message_id,
  }: {
    mailbox: string;
    message_id: string;
  }): Promise<boolean> {
    const pk = new PrivateKey.Ed25519(new Uint8Array(utils.randomBytes(32)));

    const constructionMetadata =
      await this.gateway.transaction.innerClient.transactionConstruction();

    const response =
      await this.gateway.transaction.innerClient.transactionPreview({
        transactionPreviewRequest: {
          manifest: `
  CALL_METHOD
      Address("${mailbox}")
      "delivered"
      Bytes("${strip0x(message_id)}")
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

  public async getIsmType({ ism }: { ism: string }): Promise<Isms> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(ism);

    return (details.details as EntityDetails).blueprint_name as Isms;
  }

  public async getHookType({ hook }: { hook: string }): Promise<Hooks> {
    const details =
      await this.gateway.state.getEntityDetailsVaultAggregated(hook);

    return (details.details as EntityDetails).blueprint_name as Hooks;
  }
}
