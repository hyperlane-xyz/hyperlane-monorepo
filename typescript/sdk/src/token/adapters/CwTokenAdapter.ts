import { PopulatedTransaction } from 'ethers';

import { Address } from '@hyperlane-xyz/utils';

import { BaseCwAdapter } from '../../app/MultiProtocolApp';
import { MinimalTokenMetadata } from '../config';

import { ITokenAdapter, TransferParams } from './ITokenAdapter';

// Interacts with ERC20/721 contracts
export class CwTokenAdapter extends BaseCwAdapter implements ITokenAdapter {
  async getBalance(address: Address): Promise<string> {
    throw new Error('Balance unimplemented');
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
export class CwNativeTokenAdapter extends CwTokenAdapter {}

// Interacts with Hyp Synthetic token contracts (aka 'HypTokens')
export class CwHypSyntheticAdapter extends CwTokenAdapter {}

// Interacts with HypCollateral and HypNative contracts
export class CwHypCollateralAdapter extends CwTokenAdapter {}
