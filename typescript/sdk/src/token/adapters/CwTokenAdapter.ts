import { ExecuteInstruction } from '@cosmjs/cosmwasm-stargate';

import { Address } from '@hyperlane-xyz/utils';

import { BaseCwAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ERC20Metadata } from '../config';

import { ITokenAdapter, TransferParams } from './ITokenAdapter';
import { WarpCw20QueryClient } from './WarpCw20.client';
import { TokenType, TokenTypeResponse } from './WarpCw20.types';

export type CW20Metadata = ERC20Metadata;

// TODO: import from cw20 bindings
type TokenInfoResponse = {
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
};

type AllowanceResponse = {
  allowance: {
    owner: string;
    spender: string;
  };
};

type BalanceResponse = {
  balance: string;
};

// https://github.com/CosmWasm/cw-plus/blob/main/packages/cw20/README.md
// Interacts with CW20/721 contracts
export class Cw20TokenAdapter extends BaseCwAdapter implements ITokenAdapter {
  public readonly contract: WarpCw20QueryClient;

  constructor(
    chainName: string,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.contract = new WarpCw20QueryClient(
      this.getProvider(),
      addresses.token,
    );
  }

  async getTokenType(): Promise<TokenType> {
    const tokenTypeResponse: TokenTypeResponse =
      await this.contract.tokenDefault({
        token_type: {},
      });
    return tokenTypeResponse.type;
  }

  async getBalance(address: Address): Promise<string> {
    const tokenType = await this.getTokenType();
    if ('native' in tokenType && 'fungible' in tokenType.native) {
      const ibcDenom = tokenType.native.fungible.denom;
      const coin = await this.getProvider().getBalance(address, ibcDenom);
      return coin.amount;
    } else if ('c_w20' in tokenType) {
      const cw20 = tokenType.c_w20.contract;
      const balanceResponse: BalanceResponse =
        await this.getProvider().queryContractSmart(cw20, {
          balance: {
            address,
          },
        });
      return balanceResponse.balance;
    } else {
      throw new Error(`Unsupported token type ${tokenType}`);
    }
  }

  async getMetadata(): Promise<CW20Metadata> {
    const tokenType = await this.getTokenType();
    if ('native' in tokenType && 'fungible' in tokenType.native) {
      // const ibcDenom = tokenType.native.fungible.denom;
      throw new Error('Native tokens not supported');
    } else if ('c_w20' in tokenType) {
      const cw20 = tokenType.c_w20.contract;
      const tokenInfo: TokenInfoResponse =
        await this.getProvider().queryContractSmart(cw20, {
          token_info: {},
        });
      return {
        ...tokenInfo,
        totalSupply: tokenInfo.total_supply,
      };
    } else {
      throw new Error(`Unsupported token type ${tokenType}`);
    }
  }

  async populateApproveTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<ExecuteInstruction> {
    const tokenType = await this.getTokenType();
    if ('native' in tokenType && 'fungible' in tokenType.native) {
      throw new Error('Native tokens do not require approval');
    } else if ('c_w20' in tokenType) {
      // TODO: check existing allowance
      return {
        contractAddress: tokenType.c_w20.contract,
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
    } else {
      throw new Error(`Unsupported token type ${tokenType}`);
    }
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<ExecuteInstruction> {
    const tokenType = await this.getTokenType();
    if ('native' in tokenType && 'fungible' in tokenType.native) {
      throw new Error('Native tokens do not require approval');
    } else if ('c_w20' in tokenType) {
      return {
        contractAddress: tokenType.c_w20.contract,
        msg: {
          transfer: {
            recipient,
            amount: weiAmountOrId.toString(),
          },
        },
      };
    } else {
      throw new Error(`Unsupported token type ${tokenType}`);
    }
  }
}
