import { Bank } from '@sovereign-sdk/modules';
import { UnsignedTransaction } from '@sovereign-sdk/web3';

import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseSovereignAdapter } from '../../app/MultiProtocolApp.js';
import { ITokenAdapter } from '../../index.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  InterchainGasQuote,
  QuoteTransferRemoteParams,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

export interface BaseHyperlaneRuntimeCall {
  bank?: BankCallMessage;
  warp?: WarpCallMessage;
}

export interface BankCallMessage {
  create_token?: CreateToken;
  transfer?: Transfer;
  burn?: Burn;
  mint?: Mint;
  freeze?: Freeze;
}

export interface TransferRemote {
  /**
   * The amount to transfer.
   */
  amount: number;
  /**
   * The domain of the destination chain.
   */
  destination_domain: number;
  /**
   * A limit for the payment to relayer to cover gas needed for message delivery.
   */
  gas_payment_limit: number;
  /**
   * The recipient on the destination chain.
   */
  recipient: string;
  /**
   * Selected relayer
   */
  relayer?: NewAdminClass | null;
  /**
   * The route to use for the transfer.
   */
  warp_route: string;
  [property: string]: any;
}

/**
 * A standard address derived from a SHA-256 hash of a public key.
 *
 * A VM-specific address type, allowing native support of the VM's address format.
 */
export interface NewAdminClass {
  Standard?: string;
  Vm?: string;
}

export interface WarpCallMessage {
  transfer_remote?: TransferRemote;
}

export interface Burn {
  /**
   * The amount of tokens to burn.
   */
  coins: Coins;
  [property: string]: any;
}

/**
 * The amount of tokens to transfer.
 *
 * Structure that stores information specifying a given `amount` (type [`Amount`]) of coins
 * stored at a `token_id` (type [`crate::TokenId`]).
 *
 * The amount of tokens to burn.
 *
 * The amount of tokens to mint.
 */
export interface Coins {
  /**
   * The number of tokens
   */
  amount: string | number;
  /**
   * The ID of the token
   */
  token_id: string;
  [property: string]: any;
}

export interface CreateToken {
  /**
   * Admins list.
   */
  admins: string[];
  /**
   * The initial balance of the new token.
   */
  initial_balance: number;
  /**
   * The address of the account that the new tokens are minted to.
   */
  mint_to_address: string;
  /**
   * The supply cap of the new token, if any.
   */
  supply_cap?: number | null;
  /**
   * The number of decimal places this token's amounts will have.
   */
  token_decimals?: number | null;
  /**
   * The name of the new token.
   */
  token_name: string;
  [property: string]: any;
}

export interface Freeze {
  /**
   * Address of the token to be frozen
   */
  token_id: string;
  [property: string]: any;
}

export interface Mint {
  /**
   * The amount of tokens to mint.
   */
  coins: Coins;
  /**
   * Address to mint tokens to
   */
  mint_to_address: string;
  [property: string]: any;
}

export interface Transfer {
  /**
   * The amount of tokens to transfer.
   */
  coins: Coins;
  /**
   * The address to which the tokens will be transferred.
   */
  to: string;
  [property: string]: any;
}

export class SovereignTokenAdapter
  extends BaseSovereignAdapter
  implements ITokenAdapter<UnsignedTransaction<BaseHyperlaneRuntimeCall>>
{
  // if this is not provided we will use the rollup gas token
  private tokenId?: string;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token?: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.tokenId = addresses.token;
  }

  async getBalance(address: Address): Promise<bigint> {
    const bank = await this.bank();
    return bank.balance(address, this.tokenId);
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    const bank = await this.bank();
    return bank.totalSupply(this.tokenId);
  }

  async getMetadata(isNft?: boolean): Promise<TokenMetadata> {
    // TODO: Return actual metadata
    return { decimals: 9, symbol: 'SPL', name: 'SPL Token' };
  }

  async isRevokeApprovalRequired(): Promise<boolean> {
    return false;
  }

  async getMinimumTransferAmount(): Promise<bigint> {
    return 1n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  async populateApproveTx(): Promise<
    UnsignedTransaction<BaseHyperlaneRuntimeCall>
  > {
    throw new Error('Approve not required for sovereign tokens');
  }

  async populateTransferTx(
    params: TransferParams,
  ): Promise<UnsignedTransaction<BaseHyperlaneRuntimeCall>> {
    const provider = await this.getProvider();
    const tokenId = await this.getTokenId();
    return {
      runtime_call: {
        bank: {
          transfer: {
            coins: {
              amount: params.weiAmountOrId.toString(),
              token_id: tokenId,
            },
            to: params.recipient,
          },
        },
      },
      uniqueness: { generation: Date.now() },
      details: provider.context.defaultTxDetails,
    };
  }

  async getTokenId(): Promise<string> {
    if (this.tokenId) return this.tokenId;
    const bank = await this.bank();
    this.tokenId = await bank.gasTokenId();
    return this.tokenId;
  }

  private async bank(): Promise<Bank> {
    const provider = await this.getProvider();
    return new Bank(provider as any);
  }
}

export class SovereignHypTokenAdapter
  extends SovereignTokenAdapter
  implements IHypTokenAdapter<UnsignedTransaction<BaseHyperlaneRuntimeCall>>
{
  public readonly routeId: Address;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address; routeId: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.routeId = addresses.routeId;
  }

  async getDomains(): Promise<Domain[]> {
    let routers = await this.getAllRouters();
    return routers.map((r) => r.domain);
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    let routers = await this.getAllRouters();
    let router = routers.find((r) => r.domain === domain);
    if (!router) {
      throw new Error(`No router found for domain ${domain}`);
    }
    return router.address;
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    let response = await (
      await this.getProvider()
    ).http.get(`/modules/warp/route/${this.routeId}/routers`);
    let routers = response as Record<string, unknown>['data'] as Array<{
      domain: Domain;
      address: Buffer;
    }>;
    return routers;
  }

  // Meant to be overridden by subclasses. TODO: Replace all usages of this class with subclasses
  async getBridgedSupply(): Promise<bigint | undefined> {
    // For synthetic tokens, this is just the total supply.
    // For collateral (and native), this is the amount of collateral in the module.
    return undefined;
  }

  async quoteTransferRemoteGas({
    destination,
  }: QuoteTransferRemoteParams): Promise<InterchainGasQuote> {
    const provider = await this.getProvider();
    const { amount } = await provider.http.get<
      {},
      { amount: string; token_id: string }
    >(`/modules/mailbox/quote-dispatch`, {
      query: { 'destination-domain': destination },
    });
    return {
      igpQuote: {
        amount: BigInt(amount),
      },
    };
  }

  async populateTransferRemoteTx(
    p: TransferRemoteParams,
  ): Promise<UnsignedTransaction<BaseHyperlaneRuntimeCall>> {
    const provider = await this.getProvider();
    return {
      runtime_call: {
        warp: {
          transfer_remote: {
            amount: Number(p.weiAmountOrId),
            destination_domain: p.destination,
            recipient: p.recipient,
            gas_payment_limit: 9007199254740991, // run-locally/src/sovereign uses a large value here. We try to follow it by using the largest valid number (2^53 -1)
            warp_route: this.routeId,
          },
        },
      },
      uniqueness: { generation: Date.now() },
      details: provider.context.defaultTxDetails,
    };
  }
}
