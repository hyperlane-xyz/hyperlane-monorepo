import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';
import { fromHex } from '@cosmjs/encoding';

import {
  Address,
  HexString,
  assert,
  bytesToAddressCosmos,
  ensure0x,
  pollAsync,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp.js';
import {
  Coin,
  DefaultHookResponse,
  DefaultIsmResponse,
  ExecuteMsg,
  LatestDispatchedIdResponse,
  MessageDeliveredResponse,
  NonceResponse,
  OwnerResponse,
  QueryMsg,
  RequiredHookResponse,
} from '../../cw-types/Mailbox.types.js';
import type { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';

import { ICoreAdapter } from './types.js';

const MESSAGE_DISPATCH_EVENT_TYPE = 'wasm-mailbox_dispatch';
const MESSAGE_DISPATCH_ID_EVENT_TYPE = 'wasm-mailbox_dispatch_id';
const MESSAGE_ID_ATTRIBUTE_KEY = 'message_id';
const MESSAGE_DESTINATION_ATTRIBUTE_KEY = 'destination';

type MailboxResponse =
  | DefaultHookResponse
  | RequiredHookResponse
  | DefaultIsmResponse
  | NonceResponse
  | LatestDispatchedIdResponse
  | OwnerResponse
  | MessageDeliveredResponse;

export class CosmWasmCoreAdapter
  extends BaseCosmWasmAdapter
  implements ICoreAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProviderAdapter<any>,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
    if (addresses.mailbox.startsWith('0x')) {
      const { bech32Prefix } = multiProvider.getChainMetadata(chainName);
      assert(bech32Prefix, `Missing bech32 prefix for ${chainName}`);
      this.addresses = {
        ...addresses,
        mailbox: bytesToAddressCosmos(
          fromHex(strip0x(addresses.mailbox)),
          bech32Prefix,
        ),
      };
    }
  }

  prepareMailbox(msg: ExecuteMsg, funds?: Coin[]): ExecuteInstruction {
    return {
      contractAddress: this.addresses.mailbox,
      msg,
      funds,
    };
  }

  initTransferOwner(newOwner: Address): ExecuteInstruction {
    return this.prepareMailbox({
      ownable: {
        init_ownership_transfer: {
          next_owner: newOwner,
        },
      },
    });
  }

  claimTransferOwner(): ExecuteInstruction {
    return this.prepareMailbox({
      ownable: {
        claim_ownership: {},
      },
    });
  }

  setDefaultHook(address: Address): ExecuteInstruction {
    return this.prepareMailbox({
      set_default_hook: {
        hook: address,
      },
    });
  }

  setRequiredHook(address: Address): ExecuteInstruction {
    return this.prepareMailbox({
      set_required_hook: {
        hook: address,
      },
    });
  }

  async queryMailbox<R extends MailboxResponse>(msg: QueryMsg): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.mailbox,
      msg,
    );
    return response;
  }

  async defaultHook(): Promise<string> {
    const response = await this.queryMailbox<DefaultHookResponse>({
      mailbox: {
        default_hook: {},
      },
    });
    return response.default_hook;
  }

  async defaultIsm(): Promise<string> {
    const response = await this.queryMailbox<DefaultIsmResponse>({
      mailbox: {
        default_ism: {},
      },
    });
    return response.default_ism;
  }

  async requiredHook(): Promise<string> {
    const response = await this.queryMailbox<RequiredHookResponse>({
      mailbox: {
        required_hook: {},
      },
    });
    return response.required_hook;
  }

  async nonce(): Promise<number> {
    const response = await this.queryMailbox<NonceResponse>({
      mailbox: {
        nonce: {},
      },
    });
    return response.nonce;
  }

  async latestDispatchedId(): Promise<string> {
    const response = await this.queryMailbox<LatestDispatchedIdResponse>({
      mailbox: {
        latest_dispatch_id: {},
      },
    });
    return response.message_id;
  }

  async owner(): Promise<string> {
    const response = await this.queryMailbox<OwnerResponse>({
      ownable: {
        get_owner: {},
      },
    });
    return response.owner;
  }

  async delivered(id: string): Promise<boolean> {
    const response = await this.queryMailbox<MessageDeliveredResponse>({
      mailbox: {
        message_delivered: {
          id: strip0x(id),
        },
      },
    });
    return response.delivered;
  }

  async extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Promise<Array<{ messageId: string; destination: ChainName }>> {
    if (sourceTx.type !== ProviderType.CosmJsWasm) {
      throw new Error(
        `Unsupported provider type for CosmosCoreAdapter ${sourceTx.type}`,
      );
    }
    const dispatchIdEvents = sourceTx.receipt.events.filter(
      (e) => e.type === MESSAGE_DISPATCH_ID_EVENT_TYPE,
    );
    const dispatchEvents = sourceTx.receipt.events.filter(
      (e) => e.type === MESSAGE_DISPATCH_EVENT_TYPE,
    );
    assert(
      dispatchIdEvents.length === dispatchEvents.length,
      'Mismatched dispatch and dispatch id events',
    );
    const result: Array<{ messageId: string; destination: ChainName }> = [];
    for (let i = 0; i < dispatchIdEvents.length; i++) {
      const idAttribute = dispatchIdEvents[i].attributes.find(
        (a) => a.key === MESSAGE_ID_ATTRIBUTE_KEY,
      );
      const destAttribute = dispatchEvents[i].attributes.find(
        (a) => a.key === MESSAGE_DESTINATION_ATTRIBUTE_KEY,
      );
      assert(idAttribute, 'No message id attribute found in dispatch event');
      assert(destAttribute, 'No destination attribute found in dispatch event');
      result.push({
        messageId: ensure0x(idAttribute.value),
        destination: this.multiProvider.getChainName(destAttribute.value),
      });
    }
    return result;
  }

  async waitForMessageProcessed(
    messageId: HexString,
    _destination: ChainName,
    delayMs?: number,
    maxAttempts?: number,
  ): Promise<boolean> {
    return pollAsync(
      async () => {
        const delivered = await this.isDelivered(messageId);
        assert(delivered, `Message ${messageId} not yet processed`);
        return delivered;
      },
      delayMs,
      maxAttempts,
    );
  }

  async isDelivered(
    messageId: HexString,
    _blockTag?: string | number,
  ): Promise<boolean> {
    return this.delivered(messageId);
  }
}
