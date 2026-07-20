import { type Address, address as parseAddress } from '@solana/kit';

import type { ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  CollateralCctpWarpArtifactConfig,
  DeployedWarpAddress,
} from '@hyperlane-xyz/provider-sdk/warp';

import { fetchMintTokenProgram } from '../accounts/mint.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  CCTP_MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
  CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS,
} from '../constants.js';
import {
  deriveAssociatedTokenAddress,
  deriveCctpAtaPayerPda,
  deriveCctpDenylistAccountPda,
  deriveCctpEventAuthorityPda,
  deriveCctpLocalTokenPda,
  deriveCctpMessageTransmitterPda,
  deriveCctpRemoteTokenMessengerPda,
  deriveCctpSenderAuthorityPda,
  deriveCctpTokenMessengerPda,
  deriveCctpTokenMinterPda,
  deriveHyperlaneTokenPda,
  deriveMailboxDispatchAuthorityPda,
} from '../pda.js';
import type { SvmReceipt, SvmRpc } from '../types.js';

import {
  type SvmAddressLookupTableReader,
  type SvmAddressLookupTableWriter,
} from './address-lookup-table.js';
import {
  type AnnotatedAltAddress,
  type SvmTokenAltWriter,
  SvmTokenAltReaderBase,
  canonicalize,
  createWarpAltsImpl,
} from './warp-alt.js';

/**
 * Read-only ALT surface for a CCTP SVM warp route. Every address derived
 * here is fixed (program-level or keyed only by the warp program's own
 * address / mint / configured Circle domains) — never per-transfer, which
 * is exactly what makes them safe to pre-register in an Address Lookup
 * Table. Matches the fixed portion of the account list
 * `SealevelHypCctpAdapter.buildCctpBurnAccountMetas` builds per-send in
 * `@hyperlane-xyz/sdk`, plus the receive-side (`ism.rs::verify`) fixed
 * accounts, since both share the same warp route's ALTs.
 */
export class SvmCctpTokenAltReader extends SvmTokenAltReaderBase<CollateralCctpWarpArtifactConfig> {
  constructor(
    chainName: string,
    protected readonly rpc: SvmRpc,
    altReader: SvmAddressLookupTableReader,
  ) {
    super(chainName, altReader);
  }

  async deriveWarpRouteAddresses(
    deployed: ArtifactDeployed<
      CollateralCctpWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedAltAddress[]> {
    const warpProgramId = parseAddress(deployed.deployed.address);
    const mint = parseAddress(deployed.config.token);
    const tokenProgram = await fetchMintTokenProgram(this.rpc, mint);

    const tokenPda = await deriveHyperlaneTokenPda(warpProgramId);
    const dispatchAuthority =
      await deriveMailboxDispatchAuthorityPda(warpProgramId);
    const ataPayer = await deriveCctpAtaPayerPda(warpProgramId);
    const ataPayerAta = await deriveAssociatedTokenAddress({
      wallet: ataPayer.address,
      mint,
      tokenProgram,
    });
    const senderAuthority = await deriveCctpSenderAuthorityPda();
    const denylistAccount = await deriveCctpDenylistAccountPda(
      ataPayer.address,
    );
    const messageTransmitter = await deriveCctpMessageTransmitterPda();
    const tokenMessenger = await deriveCctpTokenMessengerPda();
    const tokenMinter = await deriveCctpTokenMinterPda();
    const localToken = await deriveCctpLocalTokenPda(mint);
    const tokenMessengerMinterEventAuthority =
      await deriveCctpEventAuthorityPda(
        CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS,
      );
    const messageTransmitterEventAuthority = await deriveCctpEventAuthorityPda(
      CCTP_MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    );

    const out: AnnotatedAltAddress[] = [
      { address: warpProgramId, description: 'warp.program' },
      { address: tokenPda.address, description: 'warp.token_pda' },
      {
        address: dispatchAuthority.address,
        description: 'warp.dispatch_authority',
      },
      { address: tokenProgram, description: 'warp.token_program' },
      { address: mint, description: 'warp.cctp_mint' },
      {
        address: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        description: 'warp.associated_token_program',
      },
      { address: ataPayer.address, description: 'cctp.ata_payer' },
      { address: ataPayerAta.address, description: 'cctp.ata_payer_ata' },
      {
        address: CCTP_TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS,
        description: 'cctp.token_messenger_minter_program',
      },
      {
        address: CCTP_MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
        description: 'cctp.message_transmitter_program',
      },
      {
        address: senderAuthority.address,
        description: 'cctp.sender_authority',
      },
      {
        address: denylistAccount.address,
        description: 'cctp.denylist_account',
      },
      {
        address: messageTransmitter.address,
        description: 'cctp.message_transmitter',
      },
      { address: tokenMessenger.address, description: 'cctp.token_messenger' },
      { address: tokenMinter.address, description: 'cctp.token_minter' },
      { address: localToken.address, description: 'cctp.local_token' },
      {
        address: tokenMessengerMinterEventAuthority.address,
        description: 'cctp.token_messenger_minter_event_authority',
      },
      {
        address: messageTransmitterEventAuthority.address,
        description: 'cctp.message_transmitter_event_authority',
      },
    ];

    // One remote_token_messenger PDA per distinct configured Circle domain
    // (several Hyperlane destinations can share a Circle domain in theory,
    // so dedupe rather than deriving duplicates).
    const circleDomains = new Set(
      Object.values(deployed.config.remoteConfigs).map((c) => c.circleDomain),
    );
    for (const circleDomain of circleDomains) {
      const remoteTokenMessenger =
        await deriveCctpRemoteTokenMessengerPda(circleDomain);
      out.push({
        address: remoteTokenMessenger.address,
        description: `cctp.remote_token_messenger(circleDomain=${circleDomain})`,
      });
    }

    return canonicalize(out);
  }
}

export class SvmCctpTokenAltWriter
  extends SvmCctpTokenAltReader
  implements SvmTokenAltWriter<CollateralCctpWarpArtifactConfig>
{
  constructor(
    chainName: string,
    rpc: SvmRpc,
    protected readonly altWriter: SvmAddressLookupTableWriter,
    private readonly existingCoreAlt?: Address,
  ) {
    super(chainName, rpc, altWriter);
  }

  async create(
    deployed: ArtifactDeployed<
      CollateralCctpWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<{
    core: Address;
    warpSpecific: Address[];
    receipts: SvmReceipt[];
  }> {
    const addresses = await this.computeExpectedAltAddresses(deployed);
    return createWarpAltsImpl(this.altWriter, addresses, this.existingCoreAlt);
  }
}
