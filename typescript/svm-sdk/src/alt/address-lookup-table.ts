import { type Address, address as parseAddress } from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  assert,
  difference,
  eqAddressSol,
  isNullish,
  isZeroishAddress,
  normalizeAddressSealevel,
} from '@hyperlane-xyz/utils';

import { fetchAddressLookupTableState } from '../accounts/address-lookup-table.js';
import type { SvmSigner } from '../clients/signer.js';
import {
  getCreateAddressLookupTableInstruction,
  getExtendAddressLookupTableInstruction,
  getFreezeAddressLookupTableInstruction,
} from '../instructions/address-lookup-table.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

/**
 * Max addresses appended per extend transaction. Stays well under the
 * 1232-byte packet limit: each address is 32 bytes plus tx overhead for
 * signatures + accounts. 20 leaves comfortable headroom.
 */
const EXTEND_CHUNK_SIZE = 20;

export interface SvmAltConfig {
  /**
   * ALT authority. `null` when the table is frozen — terminal, no further
   * mutation is possible. Setting this to `null` in the expected config
   * when the on-chain authority is `Some(X)` emits a freeze.
   *
   * The on-chain ALT program does not support authority transfer, so an
   * expected owner that differs from the current on-chain authority is
   * rejected.
   */
  owner: Address | null;
  /** Addresses stored in the lookup table, in on-chain index order. */
  addresses: Address[];
}

export interface SvmDeployedAlt {
  address: Address;
  lastExtendedSlot: bigint;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export class SvmAddressLookupTableReader implements ArtifactReader<
  SvmAltConfig,
  SvmDeployedAlt
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>> {
    const altAddress = parseAddress(address);
    const { owner, addresses, lastExtendedSlot } =
      await fetchAddressLookupTableState(this.rpc, altAddress);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { owner, addresses },
      deployed: { address: altAddress, lastExtendedSlot },
    };
  }
}

export class SvmAddressLookupTableWriter
  extends SvmAddressLookupTableReader
  implements ArtifactWriter<SvmAltConfig, SvmDeployedAlt>
{
  constructor(
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<SvmAltConfig>,
  ): Promise<[ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>, SvmReceipt[]]> {
    const { owner, addresses } = artifact.config;
    const signer = this.svmSigner.signer.address;

    // The on-chain ALT program has no transfer-authority instruction, so the
    // create-time authority must be the signer. A `null` owner means
    // "freeze immediately after extends", which is also done by the signer.
    assert(
      isNullish(owner) || eqAddressSol(owner, signer),
      `SvmAddressLookupTableWriter.create: config.owner (${owner}) must equal the writer's signer (${signer}) — the ALT program has no authority-transfer instruction.`,
    );

    const recentSlot = await this.rpc.getSlot().send();
    const receipts: SvmReceipt[] = [];

    const create = await getCreateAddressLookupTableInstruction({
      authority: signer,
      payer: signer,
      recentSlot,
    });
    receipts.push(
      await this.svmSigner.send({ instructions: [create.instruction] }),
    );

    for (const batch of chunk(addresses, EXTEND_CHUNK_SIZE)) {
      const extendIx = getExtendAddressLookupTableInstruction({
        address: create.address,
        authority: signer,
        payer: signer,
        addresses: batch,
      });
      receipts.push(await this.svmSigner.send({ instructions: [extendIx] }));
    }

    if (isNullish(owner) || isZeroishAddress(owner)) {
      const freezeIx = getFreezeAddressLookupTableInstruction({
        address: create.address,
        authority: signer,
      });
      receipts.push(await this.svmSigner.send({ instructions: [freezeIx] }));
    }

    const final = await fetchAddressLookupTableState(this.rpc, create.address);
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { owner: final.owner, addresses: final.addresses },
        deployed: {
          address: create.address,
          lastExtendedSlot: final.lastExtendedSlot,
        },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<SvmAltConfig, SvmDeployedAlt>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const { address } = artifact.deployed;
    const expected = artifact.config;

    const { config: current } = await this.read(address);

    // Fail fast: a frozen ALT cannot be mutated for any reason.
    if (isNullish(current.owner) || isZeroishAddress(current.owner)) {
      throw new Error(
        `Cannot mutate ALT ${address}: table is frozen (no further extends or freezes accepted).`,
      );
    }

    // Emit txs with the on-chain authority as both signer and fee payer.
    // The actual signing happens downstream — same pattern as warp/IGP
    // writers — so the writer's own signer is only used by create().
    const authority = current.owner;
    const txs: AnnotatedSvmTransaction[] = [];

    // Address diff: ALT entries are append-only.
    const currentSet = new Set(
      current.addresses.map((a) => normalizeAddressSealevel(a)),
    );
    const expectedSet = new Set(
      expected.addresses.map((a) => normalizeAddressSealevel(a)),
    );
    const toRemove = difference(currentSet, expectedSet);
    assert(
      toRemove.size === 0,
      `Cannot remove addresses from ALT ${address}: ALT entries are append-only. Stale entries: ${[...toRemove].join(', ')}`,
    );

    const toAdd = expected.addresses.filter(
      (a) => !currentSet.has(normalizeAddressSealevel(a)),
    );
    // Emit extends first; once a freeze lands the ALT is terminal so any
    // remaining extends would fail.
    for (const batch of chunk(toAdd, EXTEND_CHUNK_SIZE)) {
      txs.push({
        feePayer: authority,
        instructions: [
          getExtendAddressLookupTableInstruction({
            address,
            authority,
            payer: authority,
            addresses: batch,
          }),
        ],
        annotation: `Extend ALT ${address} with ${batch.length} addresses`,
      });
    }

    // Owner intent: null/zeroish ⇒ freeze. Any real expected.owner must
    // match the current authority — the on-chain program has no transfer
    // instruction.
    if (isNullish(expected.owner) || isZeroishAddress(expected.owner)) {
      txs.push({
        feePayer: authority,
        instructions: [
          getFreezeAddressLookupTableInstruction({
            address,
            authority,
          }),
        ],
        annotation: `Freeze ALT ${address}`,
      });
    } else if (!eqAddressSol(expected.owner, authority)) {
      throw new Error(
        `Cannot change authority of ALT ${address} from ${authority} to ${expected.owner}: the ALT program has no authority-transfer instruction.`,
      );
    }

    return txs;
  }
}
