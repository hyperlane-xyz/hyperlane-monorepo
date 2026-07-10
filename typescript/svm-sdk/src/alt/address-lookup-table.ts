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
  chunk,
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

/**
 * Solana's ALT runtime caps each table at 256 addresses (entries are
 * append-only, no truncate instruction). Preflighting against this here
 * avoids landing the first few extends and then failing mid-loop with a
 * partially-populated, unrecoverable ALT.
 */
const ALT_MAX_ADDRESSES = 256;

/** Non-empty tuple type — at least one element required at compile time. */
export type NonEmptyArray<T> = readonly [T, ...T[]];

/**
 * ALT artifact config.
 *
 * `frozen` is a one-way bit. `false` → mutable (extends still accepted).
 * `true` → terminal: no further extends or mutations are possible.
 * Setting this to `true` when the on-chain table is still mutable emits a
 * freeze tx. The reverse transition (true → false) is rejected.
 *
 * The Solana ALT program rejects freezing an empty table, so the type is
 * a discriminated union: `frozen: true` requires at least one address at
 * compile time. Mutable ALTs may legitimately be empty (created now,
 * extended later).
 *
 * The on-chain authority is not configurable — the ALT program has no
 * transfer-authority instruction, so the create-time signer is the
 * authority for the table's lifetime. The actual authority address is
 * surfaced via `SvmDeployedAlt.authority`.
 */
export type SvmAltConfig =
  | { frozen: false; addresses: readonly Address[] }
  | { frozen: true; addresses: NonEmptyArray<Address> };

export interface SvmDeployedAlt {
  address: Address;
  lastExtendedSlot: bigint;
  /**
   * On-chain authority. Fixed at create time; `null` once the table is
   * frozen. Not user-configurable — surfaced from on-chain state.
   */
  authority: Address | null;
}

function nonEmptyArray<T>(arr: readonly T[]): NonEmptyArray<T> {
  const [first, ...rest] = arr;
  assert(!isNullish(first), 'expected non-empty array');
  return [first, ...rest];
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
    // On-chain freeze rejects empty tables (line 208 of the ALT
    // program's processor.rs), so a frozen ALT is program-guaranteed
    // non-empty — narrow via `asNonEmpty` instead of leaving the wider
    // `readonly Address[]` type from the fetched state.
    const config: SvmAltConfig = isNullish(owner)
      ? { frozen: true, addresses: nonEmptyArray(addresses) }
      : { frozen: false, addresses };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
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

    assert(
      uniqueAddresses.length <= ALT_MAX_ADDRESSES,
      `ALT exceeds the ${ALT_MAX_ADDRESSES}-address cap (${uniqueAddresses.length}); split into multiple tables.`,
    );

    // The `SvmAltConfig` union already forbids `frozen: true` with no
    // addresses at compile time, but untyped/JSON-parsed input can reach
    // here — the ALT program rejects freezing an empty table, so guard at
    // runtime too.
    assert(
      uniqueAddresses.length > 0 || !frozen,
      'Cannot create a frozen ALT with no addresses.',
    );

    // The ALT program rejects slots that aren't in the SlotHashes sysvar.
    // A finalized slot is guaranteed to have already been recorded there,
    // so it's a safe `recent_slot` for create — the alternative (tip
    // commitment) often picks the in-progress slot which isn't yet in
    // slot_hashes and trips InvalidInstructionData.
    //
    // The ALT PDA is derived from (authority, recent_slot), so two create()
    // calls by the same authority within one finalized-slot window collide
    // and the second fails with AccountAlreadyInUse. Batch tooling that
    // creates several ALTs back-to-back should space them across slots.
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

    const finalConfig: SvmAltConfig = isNullish(final.owner)
      ? { frozen: true, addresses: nonEmptyArray(final.addresses) }
      : { frozen: false, addresses: final.addresses };
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: finalConfig,
        deployed: {
          address: create.address,
          lastExtendedSlot: final.lastExtendedSlot,
          authority: final.owner,
        },
      },
      receipts,
    ];
  }

  /**
   * Returns the unsigned txs needed to reconcile the on-chain ALT with
   * `artifact.config`. After landing any extend txs returned here,
   * callers must wait at least one slot before referencing the table in
   * a v0 tx — otherwise the runtime rejects the tx with "address lookup
   * table is not activated".
   *
   * Each tx sets `feePayer` to the on-chain ALT authority so it can be
   * signed downstream by that key. Do NOT route these through this
   * writer's own `SvmSigner.send()` when the authority differs from the
   * signer: `send()` ignores `feePayer` and signs with the signer's
   * identity, which the ALT program then rejects as an invalid authority.
   */
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

    assert(
      current.addresses.length + toAdd.length <= ALT_MAX_ADDRESSES,
      `ALT ${address} would exceed the ${ALT_MAX_ADDRESSES}-address cap (current=${current.addresses.length}, adding=${toAdd.length}).`,
    );

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
