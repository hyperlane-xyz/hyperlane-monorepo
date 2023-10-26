import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';

import { Address } from '@hyperlane-xyz/utils';

import { BaseCosmWasmAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
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

// TODO: import from cw20 bindings
type TokenInfoResponse = {
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
};

type BalanceResponse = {
  balance: string;
};

// https://github.com/CosmWasm/cw-plus/blob/main/packages/cw20/README.md
// Interacts with CW20/721 contracts
export class CwTokenAdapter
  extends BaseCosmWasmAdapter
  implements ITokenAdapter
{
  public readonly contractAddress: string;

  constructor(
    chainName: string,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address },
    public readonly ibcDenom: string,
  ) {
    super(chainName, multiProvider, addresses);
    this.contractAddress = addresses.token;
  }

  async getBalance(address: Address): Promise<string> {
    const provider = await this.getProvider();
    const balanceResponse: BalanceResponse = await provider.queryContractSmart(
      this.contractAddress,
      {
        balance: {
          address,
        },
      },
    );
    return balanceResponse.balance;
  }

  async getMetadata(): Promise<CW20Metadata> {
    const provider = await this.getProvider();
    const tokenInfo: TokenInfoResponse = await provider.queryContractSmart(
      this.contractAddress,
      {
        token_info: {},
      },
    );
    return {
      ...tokenInfo,
      totalSupply: tokenInfo.total_supply,
    };
  }

  async populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<ExecuteInstruction> {
    // TODO: check existing allowance
    return {
      contractAddress: this.contractAddress,
      msg: {
        increase_allowance: {
          spender: recipient,
          amount: weiAmountOrId,
          expires: {
            never: {},
          },
        },
      },
    };
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<ExecuteInstruction> {
    return {
      contractAddress: this.contractAddress,
      msg: {
        transfer: {
          recipient,
          amount: weiAmountOrId.toString(),
        },
      },
    };
  }
}

export class CwHypTokenAdapter
  extends CwTokenAdapter
  implements IHypTokenAdapter
{
  getDomains(): Promise<number[]> {
    throw new Error('Method not implemented.');
  }

  getRouterAddress(_domain: number): Promise<Buffer> {
    throw new Error('Method not implemented.');
  }

  getAllRouters(): Promise<{ domain: number; address: Buffer }[]> {
    throw new Error('Method not implemented.');
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
    return {
      contractAddress: this.contractAddress,
      msg: {
        transfer_remote: {
          dest_domain: destination,
          recipient,
          amount: weiAmountOrId.toString(),
        },
      },
      funds: txValue
        ? [
            {
              amount: txValue.toString(),
              denom: this.ibcDenom,
            },
          ]
        : [],
    };
  }
}

export class CwHypNativeTokenAdapter
  extends CwNativeTokenAdapter
  implements IHypTokenAdapter
{
  public readonly contractAddress = this.addresses.token;

  getDomains(): Promise<number[]> {
    throw new Error('Method not implemented.');
  }

  getRouterAddress(_domain: number): Promise<Buffer> {
    throw new Error('Method not implemented.');
  }

  getAllRouters(): Promise<{ domain: number; address: Buffer }[]> {
    throw new Error('Method not implemented.');
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
    return {
      contractAddress: this.contractAddress,
      msg: {
        transfer_remote: {
          dest_domain: destination,
          recipient,
          amount: weiAmountOrId.toString(),
        },
      },
      funds: txValue
        ? [
            {
              amount: txValue.toString(),
              denom: this.ibcDenom,
            },
          ]
        : [],
    };
  }
}
