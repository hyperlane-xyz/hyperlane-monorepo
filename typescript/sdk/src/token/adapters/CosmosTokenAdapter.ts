import { MsgTransferEncodeObject } from '@cosmjs/stargate';
import { MsgTransfer } from 'cosmjs-types/ibc/applications/transfer/v1/tx';

import { Address } from '@hyperlane-xyz/utils';

import { BaseCosmosAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { MinimalTokenMetadata } from '../config';

import { ITokenAdapter, TransferParams } from './ITokenAdapter';

// Interacts with IBC denom tokens
export class NativeTokenAdapter
  extends BaseCosmosAdapter
  implements ITokenAdapter
{
  constructor(
    public readonly chainName: string,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: Record<string, Address>,
    public readonly ibcDenom: string = 'untrn',
  ) {
    super(chainName, multiProvider, addresses);
  }

  async getBalance(address: string): Promise<string> {
    const provider = await this.getProvider();
    const coin = await provider.getBalance(address, this.ibcDenom);
    return coin.amount;
  }

  getMetadata(): Promise<MinimalTokenMetadata> {
    throw new Error('Metadata not available to native tokens');
  }

  populateApproveTx(_transferParams: TransferParams): unknown {
    throw new Error('Approve not required for native tokens');
  }

  async populateTransferTx(
    transferParams: TransferParams,
  ): Promise<MsgTransferEncodeObject> {
    const transfer: MsgTransfer = {
      sourcePort: '',
      sourceChannel: '',
      token: {
        denom: this.ibcDenom,
        amount: transferParams.weiAmountOrId.toString(),
      },
      sender: '',
      receiver: '',
      timeoutHeight: {
        revisionNumber: 0n,
        revisionHeight: 0n,
      },
      timeoutTimestamp: 0n,
      memo: '', // how to encode this?
    };
    return {
      typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
      // @ts-ignore
      value: transfer,
    };
  }
}
