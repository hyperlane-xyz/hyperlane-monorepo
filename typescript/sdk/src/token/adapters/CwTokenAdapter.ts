import { Address } from '@hyperlane-xyz/utils';

import { BaseCwAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { MinimalTokenMetadata } from '../config';

import { ITokenAdapter, TransferParams } from './ITokenAdapter';
import { WarpCw20QueryClient } from './WarpCw20.client';
import { TokenTypeResponse } from './WarpCw20.types';
import { WarpNativeQueryClient } from './WarpNative.client';

// Interacts with CW20/721 contracts
export class Cw20TokenAdapter extends BaseCwAdapter implements ITokenAdapter {
  public readonly contract: WarpCw20QueryClient;

  constructor(
    chainName: string,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.contract = new WarpNativeQueryClient(
      this.getProvider(),
      addresses.token,
    );
  }

  async getBalance(address: Address): Promise<string> {
    const tokenTypeResponse: TokenTypeResponse =
      await this.contract.tokenDefault({
        token_type: {},
      });

    const tokenType = tokenTypeResponse.type;
    if ('native' in tokenType && 'fungible' in tokenType.native) {
      const ibcDenom = tokenType.native.fungible.denom;
      const coin = await this.getProvider().getBalance(address, ibcDenom);
      return coin.amount;
    } else if ('c_w20' in tokenType) {
      const cw20 = tokenType.c_w20.contract;
      return this.getProvider().queryContractSmart(cw20, {
        balance: {
          address,
        },
      });
    } else {
      throw new Error(`Unsupported token type ${tokenType}`);
    }
  }

  async getMetadata(): Promise<MinimalTokenMetadata> {
    // TODO get metadata from chainMetadata config
    throw new Error('Metadata not available to native tokens');
  }

  async populateApproveTx(
    _params: TransferParams,
  ): Promise<PopulatedTransaction> {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx({
    weiAmountOrId,
    recipient,
  }: TransferParams): Promise<PopulatedTransaction> {
    throw new Error('Transfer unimplemented');
  }
}

// Interacts with native currencies
export class CwNativeTokenAdapter
  extends BaseCwAdapter
  implements ITokenAdapter
{
  public readonly contract: WarpNativeQueryClient;

  constructor(
    chainName: string,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.contract = new WarpNativeQueryClient(
      this.getProvider(),
      addresses.token,
    );
  }

  getBalance(address: string): Promise<string> {
    throw new Error('Method not implemented.');
  }

  getMetadata(isNft?: boolean | undefined): Promise<MinimalTokenMetadata> {
    throw new Error('Method not implemented.');
  }

  populateApproveTx(TransferParams: TransferParams): unknown {
    throw new Error('Approve not required for native tokens');
  }

  populateTransferTx(TransferParams: TransferParams): unknown {
    throw new Error('Method not implemented.');
  }
}
