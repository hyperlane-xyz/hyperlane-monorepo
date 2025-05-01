import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';
import { Coin } from '@cosmjs/stargate';

import {
  Address,
  Domain,
  addressToBytes32,
  assert,
  strip0x,
} from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp.js';
import {
  BalanceResponse,
  ExecuteMsg as Cw20Execute,
  QueryMsg as Cw20Query,
  TokenInfoResponse,
} from '../../cw-types/Cw20Base.types.js';
import { QuoteDispatchResponse } from '../../cw-types/Mailbox.types.js';
import {
  DomainsResponse,
  InterchainSecurityModuleResponse,
  OwnerResponse,
  RouteResponseForHexBinary,
  RoutesResponseForHexBinary,
  TokenType,
  TokenTypeResponse,
  ExecuteMsg as WarpCw20Execute,
  QueryMsg as WarpCw20Query,
} from '../../cw-types/WarpCw20.types.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { TokenMetadata } from '../types.js';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  InterchainGasQuote,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter.js';

// Interacts with IBC denom tokens in CosmWasm
export class CwNativeTokenAdapter
  extends BaseCosmWasmAdapter
  implements ITokenAdapter<ExecuteInstruction>
{
  constructor(
    public readonly chainName: string,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: Record<string, Address>,
    public readonly denom: string,
  ) {
    super(chainName, multiProvider, addresses);
  }

  async getBalance(address: Address): Promise<bigint> {
    const provider = await this.getProvider();
    const balance = await provider.getBalance(address, this.denom);
    return BigInt(balance.amount);
  }

  async getMetadata(): Promise<CW20Metadata> {
    throw new Error('Metadata not available to native tokens');
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
  }

  async populateApproveTx(
    _params: TransferParams,
  ): Promise<ExecuteInstruction> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx({
    recipient,
    weiAmountOrId,
  }: TransferParams): Promise<ExecuteInstruction> {
    // TODO: check if this works with execute instruction? (contract type, empty message)
    return {
      contractAddress: recipient,
      msg: {},
      funds: [
        {
          amount: weiAmountOrId.toString(),
          denom: this.denom,
        },
      ],
    };
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // Not implemented.
    return undefined;
  }
}

export type CW20Metadata = TokenMetadata;
type CW20Response = TokenInfoResponse | BalanceResponse;

// Interacts with CW20/721 contracts
export class CwTokenAdapter
  extends BaseCosmWasmAdapter
  implements ITokenAdapter<ExecuteInstruction>
{
  constructor(
    public readonly chainName: string,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async queryToken<R extends CW20Response>(msg: Cw20Query): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.token,
      msg,
    );
    return response;
  }

  prepareToken(msg: Cw20Execute, funds?: Coin[]): ExecuteInstruction {
    return {
      contractAddress: this.addresses.token,
      msg,
      funds,
    };
  }

  async getBalance(address: Address): Promise<bigint> {
    const provider = await this.getProvider();
    const balance = await provider.getBalance(address, this.addresses.token);
    return BigInt(balance.amount);
  }

  async getMetadata(): Promise<CW20Metadata> {
    return this.queryToken<TokenInfoResponse>({
      token_info: {},
    });
  }

  async getMinimumTransferAmount(_recipient: Address): Promise<bigint> {
    return 0n;
  }

  async isApproveRequired(): Promise<boolean> {
    return false;
  }

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
  }

  async populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<ExecuteInstruction> {
    // TODO: check existing allowance
    return this.prepareToken({
      increase_allowance: {
        spender: recipient,
        amount: weiAmountOrId.toString(),
        expires: {
          never: {},
        },
      },
    });
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<ExecuteInstruction> {
    return this.prepareToken({
      transfer: {
        recipient,
        amount: weiAmountOrId.toString(),
      },
    });
  }

  async getTotalSupply(): Promise<bigint | undefined> {
    // Not implemented.
    return undefined;
  }
}

type TokenRouterResponse =
  | TokenTypeResponse
  | InterchainSecurityModuleResponse
  | DomainsResponse
  | OwnerResponse
  | RouteResponseForHexBinary
  | RoutesResponseForHexBinary
  | QuoteDispatchResponse;

export class CwHypSyntheticAdapter
  extends CwTokenAdapter
  implements IHypTokenAdapter<ExecuteInstruction>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { token: Address; warpRouter: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async queryRouter<R extends TokenRouterResponse>(
    msg: WarpCw20Query,
  ): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.warpRouter,
      msg,
    );
    return response;
  }

  prepareRouter(msg: WarpCw20Execute, funds?: Coin[]): ExecuteInstruction {
    return {
      contractAddress: this.addresses.warpRouter,
      msg,
      funds,
    };
  }

  async getTokenType(): Promise<TokenType> {
    const resp = await this.queryRouter<TokenTypeResponse>({
      token_default: {
        token_type: {},
      },
    });
    return resp.type;
  }

  async getInterchainSecurityModule(): Promise<Address> {
    throw new Error('Router does not support ISM config yet.');
  }

  async getOwner(): Promise<Address> {
    const resp = await this.queryRouter<OwnerResponse>({
      ownable: {
        get_owner: {},
      },
    });
    return resp.owner;
  }

  async getDomains(): Promise<Domain[]> {
    const resp = await this.queryRouter<DomainsResponse>({
      router: {
        domains: {},
      },
    });
    return resp.domains;
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    const resp = await this.queryRouter<RouteResponseForHexBinary>({
      router: {
        get_route: {
          domain,
        },
      },
    });
    const route = resp.route.route;
    if (!route) {
      throw new Error(`No route found for domain ${domain}`);
    }
    return Buffer.from(route, 'hex');
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    const resp = await this.queryRouter<RoutesResponseForHexBinary>({
      router: {
        list_routes: {},
      },
    });
    return resp.routes
      .filter((r) => r.route != null)
      .map((r) => ({
        domain: r.domain,
        address: Buffer.from(r.route!, 'hex'),
      }));
  }

  getBridgedSupply(): Promise<bigint | undefined> {
    return this.getTotalSupply();
  }

  async quoteTransferRemoteGas(
    _destination: Domain,
  ): Promise<InterchainGasQuote> {
    // TODO this may require separate queries to get the hook and/or mailbox
    // before making a query for the QuoteDispatchResponse
    // Punting on this given that only static quotes are used for now
    // const resp = await this.queryRouter<QuoteDispatchResponse>({
    //   router: {
    //     TODO: {},
    //   },
    // });
    // return {
    //   amount: BigInt(resp.gas_amount?.amount || 0),
    //   addressOrDenom: resp.gas_amount?.denom,
    // };
    throw new Error('CW adapter quoteTransferRemoteGas method not implemented');
  }

  async populateTransferRemoteTx({
    destination,
    recipient,
    weiAmountOrId,
    interchainGas,
  }: TransferRemoteParams): Promise<ExecuteInstruction> {
    if (!interchainGas)
      interchainGas = await this.quoteTransferRemoteGas(destination);
    const { addressOrDenom: igpDenom, amount: igpAmount } = interchainGas;
    assert(igpDenom, 'Interchain gas denom required for Cosmos');

    return this.prepareRouter(
      {
        transfer_remote: {
          dest_domain: destination,
          recipient: strip0x(addressToBytes32(recipient)),
          amount: weiAmountOrId.toString(),
        },
      },
      [
        {
          amount: igpAmount.toString(),
          denom: igpDenom,
        },
      ],
    );
  }
}

export class CwHypNativeAdapter
  extends CwNativeTokenAdapter
  implements IHypTokenAdapter<ExecuteInstruction>
{
  private readonly cw20adapter: CwHypSyntheticAdapter;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { warpRouter: Address },
  ) {
    super(chainName, multiProvider, addresses, '');
    this.cw20adapter = new CwHypSyntheticAdapter(chainName, multiProvider, {
      token: '',
      warpRouter: addresses.warpRouter,
    });
  }

  async getBalance(address: string): Promise<bigint> {
    const provider = await this.getProvider();
    const denom = await this.getDenom();
    const balance = await provider.getBalance(address, denom);
    return BigInt(balance.amount);
  }

  async getInterchainSecurityModule(): Promise<Address> {
    return this.cw20adapter.getInterchainSecurityModule();
  }

  async getOwner(): Promise<Address> {
    return this.cw20adapter.getOwner();
  }

  async getDomains(): Promise<Domain[]> {
    return this.cw20adapter.getDomains();
  }

  async getRouterAddress(domain: Domain): Promise<Buffer> {
    return this.cw20adapter.getRouterAddress(domain);
  }

  async getAllRouters(): Promise<Array<{ domain: Domain; address: Buffer }>> {
    return this.cw20adapter.getAllRouters();
  }

  getBridgedSupply(): Promise<bigint> {
    return this.getBalance(this.addresses.warpRouter);
  }

  quoteTransferRemoteGas(destination: Domain): Promise<InterchainGasQuote> {
    return this.cw20adapter.quoteTransferRemoteGas(destination);
  }

  async getDenom(): Promise<string> {
    const tokenType = await this.cw20adapter.getTokenType();
    if ('native' in tokenType) {
      if ('fungible' in tokenType.native) {
        return tokenType.native.fungible.denom;
      }
    }

    throw new Error(`Token type not supported: ${tokenType}`);
  }

  async populateTransferRemoteTx({
    destination,
    recipient,
    weiAmountOrId,
    interchainGas,
  }: TransferRemoteParams): Promise<ExecuteInstruction> {
    const collateralDenom = await this.getDenom();

    if (!interchainGas)
      interchainGas = await this.quoteTransferRemoteGas(destination);
    const { addressOrDenom: igpDenom, amount: igpAmount } = interchainGas;
    assert(igpDenom, 'Interchain gas denom required for Cosmos');

    // If more than one denom is used as funds, they must be sorted by the denom
    const funds: Coin[] =
      collateralDenom === igpDenom
        ? [
            {
              amount: (BigInt(weiAmountOrId) + igpAmount).toString(),
              denom: collateralDenom,
            },
          ]
        : [
            {
              amount: weiAmountOrId.toString(),
              denom: collateralDenom,
            },
            {
              amount: igpAmount.toString(),
              denom: igpDenom,
            },
          ].sort((a, b) => a.denom.localeCompare(b.denom));

    return this.cw20adapter.prepareRouter(
      {
        transfer_remote: {
          dest_domain: destination,
          recipient: strip0x(addressToBytes32(recipient)),
          amount: weiAmountOrId.toString(),
        },
      },
      funds,
    );
  }
}

export class CwHypCollateralAdapter
  extends CwHypNativeAdapter
  implements IHypTokenAdapter<ExecuteInstruction>
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { warpRouter: Address; token: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async isRevokeApprovalRequired(
    _owner: Address,
    _spender: Address,
  ): Promise<boolean> {
    return false;
  }
}
