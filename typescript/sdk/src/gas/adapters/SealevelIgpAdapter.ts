import { PublicKey } from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';

import { Address } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';
import { SealevelAccountDataWrapper } from '../../utils/sealevelSerialization.js';

import {
  SealevelOverheadIgpData,
  SealevelOverheadIgpDataSchema,
} from './serialization.js';

export class SealevelOverheadIgpAdapter extends BaseSealevelAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: { igp: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  async getAccountInfo(): Promise<SealevelOverheadIgpData> {
    const address = this.addresses.igp;
    const connection = this.getProvider();

    const accountInfo = await connection.getAccountInfo(new PublicKey(address));
    if (!accountInfo) throw new Error(`No account info found for ${address}}`);

    const accountData = deserializeUnchecked(
      SealevelOverheadIgpDataSchema,
      SealevelAccountDataWrapper,
      accountInfo.data,
    );
    return accountData.data as SealevelOverheadIgpData;
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/pda_seeds.rs#L7
  static deriveIgpProgramPda(igpProgramId: string | PublicKey): PublicKey {
    return super.derivePda(
      ['hyperlane_igp', '-', 'program_data'],
      igpProgramId,
    );
  }

  // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/rust/sealevel/programs/hyperlane-sealevel-igp/src/pda_seeds.rs#L62
  static deriveGasPaymentPda(
    igpProgramId: string | PublicKey,
    randomWalletPubKey: PublicKey,
  ): PublicKey {
    return super.derivePda(
      ['hyperlane_igp', '-', 'gas_payment', '-', randomWalletPubKey.toBuffer()],
      igpProgramId,
    );
  }
}
