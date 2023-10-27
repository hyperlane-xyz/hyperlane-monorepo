import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';
import { Coin } from '@cosmjs/stargate';

import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp';
import {
  BalanceResponse,
  ExecuteMsg as Cw20Execute,
  QueryMsg as Cw20Query,
  TokenInfoResponse,
} from '../../cw-types/Cw20Base.types';
import {
  DomainsResponse,
  InterchainSecurityModuleResponse,
  OwnerResponse,
  RouteResponseForHexBinary,
  RoutesResponseForHexBinary,
  ExecuteMsg as WarpCw20Execute,
  QueryMsg as WarpCw20Query,
} from '../../cw-types/WarpCw20.types';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ChainName } from '../../types';
import { ERC20Metadata } from '../config';

import {
  IHypTokenAdapter,
  ITokenAdapter,
  TransferParams,
  TransferRemoteParams,
} from './ITokenAdapter';

// Interacts with IBC denom tokens
export class CwNativeTokenAdapter
  extends BaseCosmWasmAdapter
  implements ITokenAdapter
{
  constructor(
    chainName: string,
    multiProvider: MultiProtocolProvider,
    public readonly ibcDenom: string,
  ) {
    super(chainName, multiProvider, {});
  }

  async getBalance(address: Address): Promise<string> {
    const provider = await this.getProvider();
    const balance = await provider.getBalance(address, this.ibcDenom);
    return balance.amount;
  }

  async getMetadata(): Promise<CW20Metadata> {
    throw new Error('Metadata not available to native tokens');
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
          denom: this.ibcDenom,
        },
      ],
    };
  }
}

export type CW20Metadata = ERC20Metadata;
type CW20Response = TokenInfoResponse | BalanceResponse;

// Interacts with CW20/721 contracts
export class CwTokenAdapter
  extends BaseCosmWasmAdapter
  implements ITokenAdapter
{
  constructor(
    public readonly chainName: string,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { token: Address },
    public readonly ibcDenom: string,
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

  async getBalance(address: Address): Promise<string> {
    const resp = await this.queryToken<BalanceResponse>({
      balance: {
        address,
      },
    });
    return resp.balance;
  }

  async getMetadata(): Promise<CW20Metadata> {
    const resp = await this.queryToken<TokenInfoResponse>({
      token_info: {},
    });
    return {
      ...resp,
      totalSupply: resp.total_supply,
    };
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
}

type TokenRouterResponse =
  | InterchainSecurityModuleResponse
  | DomainsResponse
  | OwnerResponse
  | RouteResponseForHexBinary
  | RoutesResponseForHexBinary;

export class CwHypTokenAdapter
  extends CwTokenAdapter
  implements IHypTokenAdapter
{
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { token: Address; router: Address },
    public readonly ibcDenom: string,
  ) {
    super(chainName, multiProvider, addresses, ibcDenom);
  }

  async queryRouter<R extends TokenRouterResponse>(
    msg: WarpCw20Query,
  ): Promise<R> {
    const provider = await this.getProvider();
    const response: R = await provider.queryContractSmart(
      this.addresses.router,
      msg,
    );
    return response;
  }

  prepareRouter(msg: WarpCw20Execute, funds?: Coin[]): ExecuteInstruction {
    return {
      contractAddress: this.addresses.router,
      msg,
      funds,
    };
  }

  async interchainSecurityModule(): Promise<Address> {
    throw new Error('Router does not support ISM config yet.');
  }

  async owner(): Promise<Address> {
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
    return Buffer.from(route);
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
        address: Buffer.from(r.route!),
      }));
  }

  quoteGasPayment(_destination: number): Promise<string> {
    throw new Error('Method not implemented.');
  }

  populateTransferRemoteTx({
    destination,
    recipient,
    weiAmountOrId,
    txValue,
  }: TransferRemoteParams): ExecuteInstruction {
    return this.prepareRouter(
      {
        transfer_remote: {
          dest_domain: destination,
          recipient,
          amount: weiAmountOrId.toString(),
        },
      },
      txValue
        ? [
            {
              amount: txValue.toString(),
              denom: this.ibcDenom,
            },
          ]
        : [],
    );
  }
}

export class CwHypNativeTokenAdapter
  extends CwNativeTokenAdapter
  implements IHypTokenAdapter
{
  private readonly cw20adapter: CwHypTokenAdapter;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { router: Address },
    public readonly ibcDenom: string,
  ) {
    super(chainName, multiProvider, ibcDenom);
    this.cw20adapter = new CwHypTokenAdapter(
      chainName,
      multiProvider,
      { token: '', router: addresses.router },
      ibcDenom,
    );
  }

  async interchainSecurityModule(): Promise<Address> {
    return this.cw20adapter.interchainSecurityModule();
  }

  async owner(): Promise<Address> {
    return this.cw20adapter.owner();
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

  quoteGasPayment(destination: number): Promise<string> {
    return this.cw20adapter.quoteGasPayment(destination);
  }

  populateTransferRemoteTx(params: TransferRemoteParams): ExecuteInstruction {
    return this.cw20adapter.populateTransferRemoteTx(params);
  }
}
