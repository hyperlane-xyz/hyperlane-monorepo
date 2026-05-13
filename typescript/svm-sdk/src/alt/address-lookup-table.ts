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
  isNullish,
  normalizeAddressSealevel,
  sleep,
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

/**
 * Hard cap on how long `create()` waits for the new ALT to become
 * referenceable. Solana slots are ~400ms; under any healthy validator
 * the wait is one slot. 5s is generous headroom for CI under load.
 * Polling at 1s keeps RPC pressure low while still terminating in one
 * poll in the common case.
 */
const ALT_ACTIVATION_TIMEOUT_MS = 5_000;
const ALT_ACTIVATION_POLL_MS = 1_000;

export interface SvmAltConfig {
  /**
   * One-way freeze bit. `false` → mutable (extends still accepted).
   * `true` → terminal: no further extends or mutations are possible.
   * Setting this to `true` when the on-chain table is still mutable emits
   * a freeze tx. The reverse transition (true → false) is rejected.
   *
   * The on-chain authority is not configurable — the ALT program has no
   * transfer-authority instruction, so the create-time signer is the
   * authority for the table's lifetime. The actual authority address
   * is surfaced via `SvmDeployedAlt.authority`.
   */
  frozen: boolean;
  /** Addresses stored in the lookup table, in on-chain index order. */
  addresses: Address[];
}

export interface SvmDeployedAlt {
  address: Address;
  lastExtendedSlot: bigint;
  /**
   * On-chain authority. Fixed at create time; `null` once the table is
   * frozen. Not user-configurable — surfaced from on-chain state.
   */
  authority: Address | null;
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
      config: { frozen: isNullish(owner), addresses },
      deployed: { address: altAddress, lastExtendedSlot, authority: owner },
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
    const { frozen, addresses } = artifact.config;
    const signer = this.svmSigner.signer.address;

    // Dedup by normalized form. The ALT program stores duplicates as-is
    // (wasted indexes + bytes); update() already treats the table as a
    // Set, so create() keeps the same semantics.
    const uniqueAddresses = Array.from(
      new Set(addresses.map(normalizeAddressSealevel)),
    ).map(parseAddress);

    // The ALT program rejects slots that aren't in the SlotHashes sysvar.
    // A finalized slot is guaranteed to have already been recorded there,
    // so it's a safe `recent_slot` for create — the alternative (tip
    // commitment) often picks the in-progress slot which isn't yet in
    // slot_hashes and trips InvalidInstructionData.
    const recentSlot = await this.rpc
      .getSlot({ commitment: 'finalized' })
      .send();
    const receipts: SvmReceipt[] = [];

    const create = await getCreateAddressLookupTableInstruction({
      authority: signer,
      payer: signer,
      recentSlot,
    });

    const createAltReceipt = await this.svmSigner.send({
      instructions: [create.instruction],
    });
    receipts.push(createAltReceipt);

    for (const batch of chunk(uniqueAddresses, EXTEND_CHUNK_SIZE)) {
      const extendIx = getExtendAddressLookupTableInstruction({
        address: create.address,
        authority: signer,
        payer: signer,
        addresses: batch,
      });
      receipts.push(await this.svmSigner.send({ instructions: [extendIx] }));
    }

    if (frozen) {
      const freezeIx = getFreezeAddressLookupTableInstruction({
        address: create.address,
        authority: signer,
      });

      const freezeReceipt = await this.svmSigner.send({
        instructions: [freezeIx],
      });
      receipts.push(freezeReceipt);
    }

    const final = await fetchAddressLookupTableState(this.rpc, create.address);

    // Wait for activation. v0 txs reference the ALT by index only when
    // they land at a slot strictly greater than `last_extended_slot`, so
    // poll the confirmed tip until it crosses that threshold before
    // returning — callers can then use the ALT in the very next tx
    // without their own delay.
    const deadline = Date.now() + ALT_ACTIVATION_TIMEOUT_MS;
    let currentSlot = await this.rpc
      .getSlot({ commitment: 'confirmed' })
      .send();
    while (currentSlot <= final.lastExtendedSlot) {
      assert(
        Date.now() < deadline,
        `ALT ${create.address} did not activate within ${ALT_ACTIVATION_TIMEOUT_MS}ms (last_extended_slot=${final.lastExtendedSlot}, current=${currentSlot})`,
      );
      await sleep(ALT_ACTIVATION_POLL_MS);
      currentSlot = await this.rpc.getSlot({ commitment: 'confirmed' }).send();
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { frozen: isNullish(final.owner), addresses: final.addresses },
        deployed: {
          address: create.address,
          lastExtendedSlot: final.lastExtendedSlot,
          authority: final.owner,
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

    const { config: current, deployed: currentDeployed } =
      await this.read(address);

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

    // Dedup in lockstep with `create()` — same input → same on-chain
    // table regardless of which writer entry point runs.
    const toAdd = Array.from(
      new Set(expected.addresses.map(normalizeAddressSealevel)),
    )
      .filter((a) => !currentSet.has(a))
      .map(parseAddress);

    // A frozen table accepts no further mutations. Unfreeze and extend
    // are both unsatisfiable against a frozen ALT; the only legitimate
    // reconcile is a no-op (same set, expected stays frozen).
    assert(
      !current.frozen || expected.frozen,
      `Cannot unfreeze ALT ${address}: freeze is terminal on-chain.`,
    );
    assert(
      !current.frozen || toAdd.length === 0,
      `Cannot extend ALT ${address}: table is frozen.`,
    );
    if (current.frozen) return [];

    // Unfrozen path. The on-chain authority must be set.
    assert(
      !isNullish(currentDeployed.authority),
      `ALT ${address} is reported unfrozen but has no on-chain authority — inconsistent state.`,
    );

    // Emit txs with the on-chain authority as both signer and fee payer.
    // The actual signing happens downstream — same pattern as warp/IGP
    // writers — so the writer's own signer is only used by create().
    const authority = currentDeployed.authority;
    const txs: AnnotatedSvmTransaction[] = [];

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

    if (expected.frozen) {
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
    }

    return txs;
  }
}
