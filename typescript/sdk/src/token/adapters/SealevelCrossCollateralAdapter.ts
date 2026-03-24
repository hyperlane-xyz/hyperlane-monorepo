import { PublicKey, Transaction } from '@solana/web3.js';
import { Address } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import type { IHypCrossCollateralAdapter } from './ITokenAdapter.js';
import { SealevelHypCollateralAdapter } from './SealevelTokenAdapter.js';

export class SealevelHypCrossCollateralAdapter
  extends SealevelHypCollateralAdapter
  implements IHypCrossCollateralAdapter<Transaction>
{
  constructor(
    chainName: ChainName,
    multiProvider: MultiProtocolProvider,
    addresses: { token: Address; warpRouter: Address; mailbox: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  deriveCrossCollateralStatePda(): PublicKey {
    return this.derivePda(
      ['hyperlane_token', '-', 'cross_collateral'],
      this.warpProgramPubKey,
    );
  }

  deriveCrossCollateralDispatchAuthorityPda(): PublicKey {
    return this.derivePda(
      ['hyperlane_cc', '-', 'dispatch_authority'],
      this.warpProgramPubKey,
    );
  }

  // Stub methods — will be implemented in subsequent commits
  async quoteTransferRemoteToGas(
    _params: Parameters<
      IHypCrossCollateralAdapter<Transaction>['quoteTransferRemoteToGas']
    >[0],
  ) {
    return this.quoteTransferRemoteGas({
      destination: _params.destination,
      sender: _params.sender,
    });
  }

  async populateTransferRemoteToTx(
    _params: Parameters<
      IHypCrossCollateralAdapter<Transaction>['populateTransferRemoteToTx']
    >[0],
  ): Promise<Transaction> {
    throw new Error('Not yet implemented');
  }
}
