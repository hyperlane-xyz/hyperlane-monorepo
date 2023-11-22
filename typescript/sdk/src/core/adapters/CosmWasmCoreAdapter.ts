import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';

import { Address, HexString } from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp';
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
} from '../../cw-types/Mailbox.types';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import {
  ProviderType,
  TypedTransactionReceipt,
} from '../../providers/ProviderType';
import { ChainName } from '../../types';

import { ICoreAdapter } from './types';

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
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
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
          id,
        },
      },
    });
    return response.delivered;
  }

  extractMessageIds(
    sourceTx: TypedTransactionReceipt,
  ): Array<{ messageId: string; destination: ChainName }> {
    if (sourceTx.type !== ProviderType.CosmJsWasm) {
      throw new Error(
        `Unsupported provider type for CosmosCoreAdapter ${sourceTx.type}`,
      );
    }
    // TODO: parse mailbox logs and extract message ids
    throw new Error('Method not implemented.');
  }

  async waitForMessageProcessed(
    _messageId: HexString,
    _destination: ChainName,
    _delayMs?: number,
    _maxAttempts?: number,
  ): Promise<boolean> {
    throw new Error('Method not implemented.');
  }
}
