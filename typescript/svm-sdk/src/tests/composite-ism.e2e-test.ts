import { address, type Address, generateKeyPairSigner } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  CompositeIsmArtifactConfig,
  CompositeIsmNodeArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { assert } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import {
  CompositeIsmInstructionKind,
  decodeCompositeIsmInstructionKind,
} from '../instructions/composite-ism.js';
import {
  SvmCompositeIsmReader,
  SvmCompositeIsmWriter,
} from '../ism/composite-ism.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';
import type { AnnotatedSvmTransaction, SvmDeployedIsm } from '../types.js';

const TEST_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';
const ALT_OWNER_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000002';

/**
 * True if any instruction in `tx` is the given composite ISM instruction
 * kind, decoded from the actual wire data rather than matched against
 * `tx.annotation` — annotations are cosmetic display text and can change
 * without the instruction itself changing.
 */
function txHasInstructionKind(
  tx: AnnotatedSvmTransaction,
  kind: CompositeIsmInstructionKind,
): boolean {
  return tx.instructions.some(
    (ix) => decodeCompositeIsmInstructionKind(ix.data) === kind,
  );
}

describe('SVM Composite ISM E2E Tests', function () {
  this.timeout(180_000);

  let rpc: ReturnType<typeof createRpc>;
  let signer: SvmSigner;
  let altOwnerSigner: SvmSigner;
  let programId: Address;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    signer = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TEST_PRIVATE_KEY,
    );
    altOwnerSigner = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      ALT_OWNER_PRIVATE_KEY,
    );

    // This suite deploys composite-ism (~260KB) fresh multiple times (each
    // instance's ProgramData account permanently locks ~2+ SOL in rent,
    // unlike buffer rent which is refunded at finalize) — once here, and
    // again in the domain-staleness, activation-ordering, batching,
    // maximal-tree, and non-deployer-owner tests below — plus several
    // update/pause/ownership transactions, so a larger airdrop than a
    // single-deploy test needs is required.
    await airdropSol(rpc, address(signer.getSignerAddress()), 40_000_000_000n);
    await airdropSol(
      rpc,
      address(altOwnerSigner.getSignerAddress()),
      5_000_000_000n,
    );

    // Deploy composite-ism fresh (the real production path — each core/warp
    // deployment gets its own instance) rather than using a preloaded
    // well-known program ID. solana-test-validator's `--bpf-program` preload
    // mechanism loads programs as upgradeable with a zero-filled "Some(default
    // pubkey)" authority, which no real keypair can ever satisfy, so
    // Initialize's upgrade-authority gate would always fail against it.
    const writer = new SvmCompositeIsmWriter(
      { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm } },
      rpc,
      signer,
    );
    const [deployed] = await writer.create({
      artifactState: ArtifactState.NEW,
      config: {
        type: 'compositeIsm',
        owner: signer.signer.address,
        root: { type: 'pausable', paused: false },
      },
    });
    programId = deployed.deployed.programId;
  });

  describe('create + read', () => {
    it('initialized a pausable root and can read it back', async () => {
      const reader = new SvmCompositeIsmReader(rpc);
      const readResult = await reader.read(programId);
      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config).to.deep.equal({
        type: 'compositeIsm',
        owner: signer.signer.address,
        root: { type: 'pausable', paused: false },
      });
    });
  });

  describe('ISM Artifact Manager', () => {
    it('detects compositeIsm type from address', async () => {
      const manager = new SvmIsmArtifactManager(rpc);
      const artifact = await manager.readIsm(programId);
      expect(artifact.config.type).to.equal(IsmType.COMPOSITE);
    });

    it('creates a composite ISM reader/writer via the manager', () => {
      const manager = new SvmIsmArtifactManager(rpc);
      const reader = manager.createReader('compositeIsm');
      expect(reader).to.be.instanceOf(SvmCompositeIsmReader);
      const writer = manager.createWriter('compositeIsm', signer);
      expect(writer).to.be.instanceOf(SvmCompositeIsmWriter);
    });
  });

  describe('update — root diff', () => {
    it('flips pausable.paused via UpdateConfig', async () => {
      const writer = new SvmCompositeIsmWriter(
        { program: { programId } },
        rpc,
        signer,
      );

      const current = await writer.read(programId);
      assert(current.config.root.type === 'pausable', 'expected pausable root');
      expect(current.config.root.paused).to.equal(false);

      const expected: ArtifactDeployed<
        CompositeIsmArtifactConfig,
        SvmDeployedIsm
      > = {
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: { type: 'pausable', paused: true },
        },
        deployed: current.deployed,
      };

      const txs = await writer.update(expected);
      expect(txs).to.have.length.greaterThan(0);
      for (const tx of txs) {
        await signer.send(tx);
      }

      const after = await writer.read(programId);
      assert(after.config.root.type === 'pausable', 'expected pausable root');
      expect(after.config.root.paused).to.equal(true);
    });

    it('is idempotent — returns no transactions when config is unchanged', async () => {
      const writer = new SvmCompositeIsmWriter(
        { program: { programId } },
        rpc,
        signer,
      );

      const current = await writer.read(programId);
      const txs = await writer.update({
        ...current,
        config: current.config,
      });
      expect(txs).to.have.length(0);
    });

    it('is idempotent for a leading-zero decimal maxCapacity/threshold, matching the on-chain canonical form', async () => {
      // normalizeForCompare canonicalizes decimal strings via
      // BigInt(x).toString() specifically so a config-supplied leading-zero
      // value (e.g. from hand-edited YAML) doesn't cause update() to emit a
      // spurious UpdateConfig — which would reset a rateLimited node's
      // on-chain filledLevel to full capacity on every apply.
      const writer = new SvmCompositeIsmWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm } },
        rpc,
        signer,
      );

      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'amountRouting',
            threshold: '1000000',
            lower: {
              type: 'rateLimited',
              maxCapacity: '86400',
              mailbox: signer.signer.address,
              recipient: '0x' + '7'.repeat(64),
            },
            upper: { type: 'test', accept: false },
          },
        },
      });
      const localProgramId = deployed.deployed.programId;

      const current = await writer.read(localProgramId);
      assert(
        current.config.root.type === 'amountRouting',
        'expected amountRouting root',
      );
      const txs = await writer.update({
        ...current,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'amountRouting',
            // Leading-zero forms of the same values already on-chain.
            threshold: '001000000',
            lower: {
              type: 'rateLimited',
              maxCapacity: '086400',
              mailbox: signer.signer.address,
              recipient: '0x' + '7'.repeat(64),
            },
            upper: { type: 'test', accept: false },
          },
        },
      });
      expect(txs).to.have.length(0);
    });
  });

  describe('pause / unpause', () => {
    it('pauses and unpauses every Pausable node in the tree', async () => {
      const writer = new SvmCompositeIsmWriter(
        { program: { programId } },
        rpc,
        signer,
      );

      // On-chain root is `{ type: 'pausable', paused: true }` from the
      // previous describe block; unpause() should flip it back to false
      // without needing an explicit UpdateConfig.
      const unpauseTx = await writer.unpause(programId);
      await signer.send(unpauseTx);

      let read = await writer.read(programId);
      assert(read.config.root.type === 'pausable', 'expected pausable root');
      expect(read.config.root.paused).to.equal(false);

      const pauseTx = await writer.pause(programId);
      await signer.send(pauseTx);

      read = await writer.read(programId);
      assert(read.config.root.type === 'pausable', 'expected pausable root');
      expect(read.config.root.paused).to.equal(true);
    });
  });

  describe('update — ownership transfer', () => {
    it('transfers ownership when config.owner differs from on-chain owner', async () => {
      const writer = new SvmCompositeIsmWriter(
        { program: { programId } },
        rpc,
        signer,
      );

      const current = await writer.read(programId);
      expect(current.config.owner).to.equal(signer.signer.address);

      const expected: ArtifactDeployed<
        CompositeIsmArtifactConfig,
        SvmDeployedIsm
      > = {
        ...current,
        config: {
          ...current.config,
          owner: altOwnerSigner.signer.address,
        },
      };

      const txs = await writer.update(expected);
      expect(txs).to.have.length.greaterThan(0);
      for (const tx of txs) {
        await signer.send(tx);
      }

      const after = await writer.read(programId);
      expect(after.config.owner).to.equal(altOwnerSigner.signer.address);

      // Restore ownership using the new owner's signer, for subsequent tests.
      const altWriter = new SvmCompositeIsmWriter(
        { program: { programId } },
        rpc,
        altOwnerSigner,
      );
      const restoreTxs = await altWriter.update({
        ...after,
        config: { ...after.config, owner: signer.signer.address },
      });
      for (const tx of restoreTxs) {
        await altOwnerSigner.send(tx);
      }
    });

    it('edits a domain and transfers ownership in one update() call', async () => {
      // Ownership transfer is placed last precisely because domain/root
      // instructions require the CURRENT on-chain owner as signer — this
      // test exercises that exact scenario (not just an ownership-only
      // change) to confirm the domain edit isn't sent after the transfer,
      // which would fail since `signer` would no longer be the owner.
      const writer = new SvmCompositeIsmWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm } },
        rpc,
        signer,
      );

      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'routing',
            domains: { 31: { type: 'test', accept: true } },
          },
        },
      });
      const localProgramId = deployed.deployed.programId;

      const current = await writer.read(localProgramId);
      const txs = await writer.update({
        ...current,
        config: {
          type: 'compositeIsm',
          owner: altOwnerSigner.signer.address,
          root: {
            type: 'routing',
            domains: { 31: { type: 'test', accept: false } },
          },
        },
      });
      expect(txs).to.have.length.greaterThan(1);
      for (const tx of txs) {
        await signer.send(tx);
      }

      const after = await writer.read(localProgramId);
      expect(after.config.owner).to.equal(altOwnerSigner.signer.address);
      assert(after.config.root.type === 'routing', 'expected routing root');
      expect(after.config.root.domains).to.deep.equal({
        31: { type: 'test', accept: false },
      });
    });
  });

  describe('routing domains', () => {
    it('creates a routing root with domain overrides and diffs them on update', async () => {
      const writer = new SvmCompositeIsmWriter(
        { program: { programId } },
        rpc,
        signer,
      );

      // Note: `pausable` nodes are rejected inside domain PDAs by the
      // program (Error::PausableInDomainIsm — pause propagation doesn't
      // reach domain PDAs), so domain overrides below use `test`/
      // `trustedRelayer` instead.
      const rootWithDomains: CompositeIsmNodeArtifactConfig = {
        type: 'routing',
        domains: {
          1: { type: 'test', accept: true },
          137: {
            type: 'trustedRelayer',
            relayer: altOwnerSigner.signer.address,
          },
        },
      };

      const config: CompositeIsmArtifactConfig = {
        type: 'compositeIsm',
        owner: signer.signer.address,
        root: rootWithDomains,
      };

      const current = await writer.read(programId);
      const txs = await writer.update({ ...current, config });
      expect(txs).to.have.length.greaterThan(0);
      for (const tx of txs) {
        await signer.send(tx);
      }

      const afterSet = await writer.read(programId);
      assert(afterSet.config.root.type === 'routing', 'expected routing root');
      expect(afterSet.config.root.domains).to.deep.equal({
        1: { type: 'test', accept: true },
        137: { type: 'trustedRelayer', relayer: altOwnerSigner.signer.address },
      });

      // Remove domain 137, change domain 1, add domain 42.
      const updatedConfig: CompositeIsmArtifactConfig = {
        type: 'compositeIsm',
        owner: signer.signer.address,
        root: {
          type: 'routing',
          domains: {
            1: { type: 'test', accept: false },
            42: { type: 'trustedRelayer', relayer: signer.signer.address },
          },
        },
      };

      const diffTxs = await writer.update({
        ...afterSet,
        config: updatedConfig,
      });
      expect(diffTxs).to.have.length.greaterThan(0);
      for (const tx of diffTxs) {
        await signer.send(tx);
      }

      const afterDiff = await writer.read(programId);
      assert(afterDiff.config.root.type === 'routing', 'expected routing root');
      expect(afterDiff.config.root.domains).to.deep.equal({
        1: { type: 'test', accept: false },
        42: { type: 'trustedRelayer', relayer: signer.signer.address },
      });
    });

    it('diffs a domain living under an aggregation (not a top-level routing root)', async () => {
      // Every other update() test in this suite uses a top-level `routing`
      // root. extractDomains/stripDomains recurse into aggregation.subIsms
      // and amountRouting.lower/upper to find the domains map wherever it
      // is — if that recursion broke, update() would silently fail to
      // reconcile domains for any tree where routing isn't the root (a
      // realistic config shape), with no other test catching it.
      const writer = new SvmCompositeIsmWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm } },
        rpc,
        signer,
      );

      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'aggregation',
            threshold: 1,
            subIsms: [
              { type: 'test', accept: true },
              {
                type: 'routing',
                domains: { 51: { type: 'test', accept: true } },
              },
            ],
          },
        },
      });
      const localProgramId = deployed.deployed.programId;

      const current = await writer.read(localProgramId);
      const txs = await writer.update({
        ...current,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'aggregation',
            threshold: 1,
            subIsms: [
              { type: 'test', accept: true },
              {
                type: 'routing',
                domains: { 51: { type: 'test', accept: false } },
              },
            ],
          },
        },
      });
      expect(txs).to.have.length.greaterThan(0);
      for (const tx of txs) {
        await signer.send(tx);
      }

      const after = await writer.read(localProgramId);
      assert(
        after.config.root.type === 'aggregation',
        'expected aggregation root',
      );
      const routingSub = after.config.root.subIsms.find(
        (sub) => sub.type === 'routing',
      );
      assert(routingSub?.type === 'routing', 'expected nested routing sub-ism');
      expect(routingSub.domains).to.deep.equal({
        51: { type: 'test', accept: false },
      });
    });
  });

  describe('domain PDA staleness across partial multi-tx updates', () => {
    it('does not resurrect a stale domain PDA after a partially-applied root change', async () => {
      const writer = new SvmCompositeIsmWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm } },
        rpc,
        signer,
      );

      // Deploy with a routing root + domain 7.
      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'routing',
            domains: { 7: { type: 'test', accept: true } },
          },
        },
      });
      const localProgramId = deployed.deployed.programId;

      // Update to a non-routing root. This returns two independent
      // transactions: one UpdateConfig (root change) and one
      // RemoveCompositeIsmDomain(7). Simulate a partially-applied `warp
      // apply` by sending only the root-change transaction — domain 7's
      // PDA is left orphaned on-chain, exactly as a real interrupted apply
      // (network blip, insufficient funds mid-batch, etc.) would leave it.
      const current = await writer.read(localProgramId);
      const txs = await writer.update({
        ...current,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: { type: 'test', accept: true },
        },
      });
      const removeDomainTx = txs.find((tx) =>
        txHasInstructionKind(tx, CompositeIsmInstructionKind.RemoveDomainIsm),
      );
      assert(removeDomainTx, 'expected a RemoveCompositeIsmDomain transaction');
      for (const tx of txs) {
        if (tx === removeDomainTx) continue;
        await signer.send(tx);
      }

      const afterPartial = await writer.read(localProgramId);
      assert(
        afterPartial.config.root.type === 'test',
        'expected non-routing root after partial apply',
      );

      // Switch back to routing with a different domain (9, not 7). If the
      // stale domain-7 PDA isn't diffed against the raw on-chain domain
      // map, it silently becomes live again the moment the root is
      // routing.
      const backToRoutingTxs = await writer.update({
        ...afterPartial,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'routing',
            domains: { 9: { type: 'test', accept: false } },
          },
        },
      });
      for (const tx of backToRoutingTxs) {
        await signer.send(tx);
      }

      const final = await writer.read(localProgramId);
      assert(final.config.root.type === 'routing', 'expected routing root');
      expect(final.config.root.domains).to.deep.equal({
        9: { type: 'test', accept: false },
      });
    });

    it('reconciles domains before activating routing, so a stale domain is never briefly live', async () => {
      const writer = new SvmCompositeIsmWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm } },
        rpc,
        signer,
      );

      // Deploy with a routing root + domain 11, then partially apply a
      // switch to non-routing (send only the root-change transaction) so
      // domain 11's PDA is left orphaned on-chain — the same precondition
      // as the previous test, but this time we switch back to a DIFFERENT
      // domain (13) in one step, exercising the activating-routing path.
      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'routing',
            domains: { 11: { type: 'test', accept: true } },
          },
        },
      });
      const localProgramId = deployed.deployed.programId;

      const current = await writer.read(localProgramId);
      const toNonRoutingTxs = await writer.update({
        ...current,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: { type: 'test', accept: true },
        },
      });
      const removeDomainTx = toNonRoutingTxs.find((tx) =>
        txHasInstructionKind(tx, CompositeIsmInstructionKind.RemoveDomainIsm),
      );
      assert(removeDomainTx, 'expected a RemoveCompositeIsmDomain transaction');
      for (const tx of toNonRoutingTxs) {
        if (tx === removeDomainTx) continue;
        await signer.send(tx);
      }

      const nonRoutingState = await writer.read(localProgramId);
      assert(
        nonRoutingState.config.root.type === 'test',
        'expected non-routing root after partial apply',
      );

      // Now activate routing with domain 13. The returned transactions
      // must reconcile domains (remove 11, set 13) BEFORE the root update
      // that activates routing — otherwise activating routing first would
      // make stale domain 11 briefly (or, under another partial failure,
      // indefinitely) live before its removal is applied.
      const activateTxs = await writer.update({
        ...nonRoutingState,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'routing',
            domains: { 13: { type: 'test', accept: false } },
          },
        },
      });

      const rootTxIndex = activateTxs.findIndex((tx) =>
        txHasInstructionKind(tx, CompositeIsmInstructionKind.UpdateConfig),
      );
      const domainTxIndices = activateTxs
        .map((tx, i) =>
          txHasInstructionKind(tx, CompositeIsmInstructionKind.SetDomainIsm) ||
          txHasInstructionKind(tx, CompositeIsmInstructionKind.RemoveDomainIsm)
            ? i
            : -1,
        )
        .filter((i) => i >= 0);
      assert(rootTxIndex >= 0, 'expected a root UpdateConfig transaction');
      assert(domainTxIndices.length > 0, 'expected domain transactions');
      expect(Math.max(...domainTxIndices)).to.be.lessThan(rootTxIndex);

      for (const tx of activateTxs) {
        await signer.send(tx);
      }

      const final = await writer.read(localProgramId);
      assert(final.config.root.type === 'routing', 'expected routing root');
      expect(final.config.root.domains).to.deep.equal({
        13: { type: 'test', accept: false },
      });
    });

    it('reconciles domains before activating a routing node nested inside an aggregation', async () => {
      const writer = new SvmCompositeIsmWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm } },
        rpc,
        signer,
      );

      // Same partial-apply precondition as the top-level-routing test
      // above, but this time the tree we activate wraps the routing node
      // inside an aggregation — containsRoutingNode must recurse into
      // subIsms to detect this as "activating routing", not just check the
      // tree's own top-level type.
      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'routing',
            domains: { 21: { type: 'test', accept: true } },
          },
        },
      });
      const localProgramId = deployed.deployed.programId;

      const current = await writer.read(localProgramId);
      const toNonRoutingTxs = await writer.update({
        ...current,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: { type: 'test', accept: true },
        },
      });
      const removeDomainTx = toNonRoutingTxs.find((tx) =>
        txHasInstructionKind(tx, CompositeIsmInstructionKind.RemoveDomainIsm),
      );
      assert(removeDomainTx, 'expected a RemoveCompositeIsmDomain transaction');
      for (const tx of toNonRoutingTxs) {
        if (tx === removeDomainTx) continue;
        await signer.send(tx);
      }

      const nonRoutingState = await writer.read(localProgramId);
      assert(
        nonRoutingState.config.root.type === 'test',
        'expected non-routing root after partial apply',
      );

      const activateTxs = await writer.update({
        ...nonRoutingState,
        config: {
          type: 'compositeIsm',
          owner: signer.signer.address,
          root: {
            type: 'aggregation',
            threshold: 1,
            subIsms: [
              { type: 'test', accept: true },
              {
                type: 'routing',
                domains: { 23: { type: 'test', accept: false } },
              },
            ],
          },
        },
      });

      const rootTxIndex = activateTxs.findIndex((tx) =>
        txHasInstructionKind(tx, CompositeIsmInstructionKind.UpdateConfig),
      );
      const domainTxIndices = activateTxs
        .map((tx, i) =>
          txHasInstructionKind(tx, CompositeIsmInstructionKind.SetDomainIsm) ||
          txHasInstructionKind(tx, CompositeIsmInstructionKind.RemoveDomainIsm)
            ? i
            : -1,
        )
        .filter((i) => i >= 0);
      assert(rootTxIndex >= 0, 'expected a root UpdateConfig transaction');
      assert(domainTxIndices.length > 0, 'expected domain transactions');
      expect(Math.max(...domainTxIndices)).to.be.lessThan(rootTxIndex);

      for (const tx of activateTxs) {
        await signer.send(tx);
      }

      const final = await writer.read(localProgramId);
      assert(
        final.config.root.type === 'aggregation',
        'expected aggregation root',
      );
      const routingSub = final.config.root.subIsms.find(
        (sub) => sub.type === 'routing',
      );
      assert(routingSub?.type === 'routing', 'expected nested routing sub-ism');
      expect(routingSub.domains).to.deep.equal({
        23: { type: 'test', accept: false },
      });
    });
  });

  describe('domain instruction batching respects Solana tx size limit', () => {
    it('splits large multisig domain overrides across multiple transactions', async () => {
      // A fixed instructions-per-tx count is unsafe here — each domain
      // instruction carries a variable-sized recursive IsmNode, so a
      // handful of large multisig overrides can already exceed Solana's
      // 1232-byte transaction limit well before a fixed count is reached.
      const manyValidators = Array.from(
        { length: 15 },
        (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'),
      );

      const domains: Record<number, CompositeIsmNodeArtifactConfig> = {};
      for (let domain = 1; domain <= 6; domain++) {
        domains[domain] = {
          type: 'multisigMessageId',
          validators: manyValidators,
          threshold: 8,
        };
      }

      const config: CompositeIsmArtifactConfig = {
        type: 'compositeIsm',
        owner: signer.signer.address,
        root: { type: 'routing', domains },
      };

      const writer = new SvmCompositeIsmWriter(
        { program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm } },
        rpc,
        signer,
      );

      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config,
      });

      // 6 domain instructions this large can't fit 5-per-tx (the previous
      // fixed batch size) — that would have built an oversized transaction
      // and failed to send. Confirm it succeeded and used more than one
      // domain-instruction batch (beyond the single Initialize receipt).
      expect(receipts.length).to.be.greaterThan(2);

      const reader = new SvmCompositeIsmReader(rpc);
      const readResult = await reader.read(deployed.deployed.programId);
      expect(readResult.config).to.deep.equal(config);
    });
  });

  describe('maximal tree — every node kind in one aggregation', () => {
    it('deploys and reads back an aggregation containing all 9 node kinds', async () => {
      // Only one Routing-type node (Routing XOR FallbackRouting) is allowed
      // per tree — FallbackRouting is used here since it also exercises a
      // field (fallback_ism) and a domains map; bare `routing` is already
      // covered by the "routing domains" describe block above.
      const fallbackTarget = await generateKeyPairSigner();

      const maximalRoot: CompositeIsmNodeArtifactConfig = {
        type: 'aggregation',
        threshold: 4,
        subIsms: [
          { type: 'trustedRelayer', relayer: altOwnerSigner.signer.address },
          {
            type: 'multisigMessageId',
            validators: [
              '0x1111111111111111111111111111111111111111',
              '0x2222222222222222222222222222222222222222',
            ],
            threshold: 1,
          },
          { type: 'test', accept: true },
          { type: 'pausable', paused: false },
          {
            type: 'rateLimited',
            maxCapacity: '86400',
            mailbox: signer.signer.address,
            // RateLimited requires a non-zero recipient — a zero/omitted
            // recipient is rejected by validate_config (InvalidConfig).
            recipient: '0x' + '5'.repeat(64),
          },
          {
            type: 'amountRouting',
            threshold: '1000000',
            lower: { type: 'test', accept: false },
            upper: { type: 'pausable', paused: true },
          },
          // Must be last — FallbackRouting elsewhere would drain
          // accounts_iter and starve subsequent siblings (FallbackRoutingNotLast).
          {
            type: 'fallbackRouting',
            fallbackIsm: fallbackTarget.address,
            domains: {
              1: { type: 'trustedRelayer', relayer: signer.signer.address },
            },
          },
        ],
      };

      const config: CompositeIsmArtifactConfig = {
        type: 'compositeIsm',
        owner: signer.signer.address,
        root: maximalRoot,
      };

      const writer = new SvmCompositeIsmWriter(
        {
          program: {
            programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm,
          },
        },
        rpc,
        signer,
      );

      const [deployed, receipts] = await writer.create({
        artifactState: ArtifactState.NEW,
        config,
      });

      expect(receipts).to.have.length.greaterThan(0);
      expect(deployed.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(deployed.config).to.deep.equal(config);

      const reader = new SvmCompositeIsmReader(rpc);
      const readResult = await reader.read(deployed.deployed.programId);
      expect(readResult.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(readResult.config).to.deep.equal(config);
    });
  });

  describe('create — non-deployer owner combined with domains', () => {
    it('sets domains successfully even when config.owner differs from the deploying signer', async () => {
      // Regression test: create() must send SetDomainIsm *before*
      // TransferOwnership. Every mutating instruction requires the CURRENT
      // on-chain owner as signer, so if ownership were transferred away from
      // `signer` first, the domain instructions below (still signed by
      // `signer`) would be rejected on-chain.
      const writer = new SvmCompositeIsmWriter(
        {
          program: {
            programBytes: HYPERLANE_SVM_PROGRAM_BYTES.compositeIsm,
          },
        },
        rpc,
        signer,
      );

      const config: CompositeIsmArtifactConfig = {
        type: 'compositeIsm',
        owner: altOwnerSigner.signer.address,
        root: {
          type: 'routing',
          domains: {
            1: { type: 'test', accept: true },
          },
        },
      };

      const [deployed] = await writer.create({
        artifactState: ArtifactState.NEW,
        config,
      });

      const reader = new SvmCompositeIsmReader(rpc);
      const readResult = await reader.read(deployed.deployed.programId);
      expect(readResult.config).to.deep.equal(config);
    });
  });
});
