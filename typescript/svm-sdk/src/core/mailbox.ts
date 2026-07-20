import { address as parseAddress } from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedMailboxAddress,
  MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  eqAddressSol,
  eqOptionalAddress,
  isEmptyAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { getProgramUpgradeAuthority } from '../deploy/program-deployer.js';
import { prepareProgramUpgrade } from '../deploy/program-upgrade.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import { getSetUpgradeAuthorityInstruction } from '../instructions/loader.js';
import {
  hasProgramBytes,
  type AnnotatedSvmTransaction,
  type SvmReceipt,
  type SvmRpc,
} from '../types.js';

import {
  buildInitMailboxInstruction,
  buildSetDefaultIsmInstruction,
  buildTransferMailboxOwnershipInstruction,
  type MailboxInitData,
} from './mailbox-tx.js';
import {
  fetchMailboxInboxAccount,
  fetchMailboxOutboxAccount,
  fetchMailboxProgramVersion,
} from './mailbox-query.js';
import { DEFAULT_COMPUTE_UNITS } from '../constants.js';
import type { SvmMailboxConfig } from './types.js';

// Default protocol fee values for mailbox initialization.
const DEFAULT_MAX_PROTOCOL_FEE = 1_000_000_000n;
const DEFAULT_PROTOCOL_FEE = 0n;

export class SvmMailboxReader implements ArtifactReader<
  MailboxOnChain,
  DeployedMailboxAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>> {
    const programId = parseAddress(address);

    const inbox = await fetchMailboxInboxAccount(this.rpc, programId);
    assert(inbox, `Mailbox inbox not initialized at ${programId}`);

    const outbox = await fetchMailboxOutboxAccount(this.rpc, programId);
    assert(outbox, `Mailbox outbox not initialized at ${programId}`);

    const contractVersion = await fetchMailboxProgramVersion(
      this.rpc,
      programId,
      outbox.owner,
    );

    // On SVM the mailbox IS the merkle tree hook — return the mailbox
    // address for both defaultHook and requiredHook as UNDERIVED artifacts.
    // NOTE: This is lossy. The SVM outbox account has no hook fields, so we
    // cannot recover the original hook config (e.g. IGP). A `core read` →
    // `core apply` round-trip with a non-merkleTreeHook config will redeploy
    // hooks that already exist.
    // Original hook addresses can be retrieved from the registry addresses if needed.
    const mailboxHookRef = {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: programId },
    };

    const config: MailboxOnChain = {
      owner: outbox.owner ?? ZERO_ADDRESS_HEX_32,
      defaultIsm: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: inbox.defaultIsm },
      },
      defaultHook: mailboxHookRef,
      requiredHook: mailboxHookRef,
      contractVersion: contractVersion ?? undefined,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: programId,
        domainId: inbox.localDomain,
      },
    };
  }
}

export class SvmMailboxWriter
  extends SvmMailboxReader
  implements ArtifactWriter<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(
    private readonly config: SvmMailboxConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<MailboxOnChain>,
  ): Promise<
    [ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>, SvmReceipt[]]
  > {
    const receipts: SvmReceipt[] = [];
    const mailboxConfig = artifact.config;

    const { programAddress, receipts: deployReceipts } = await resolveProgram(
      this.config.program,
      this.svmSigner,
      this.rpc,
    );
    receipts.push(...deployReceipts);

    const existing = await fetchMailboxInboxAccount(this.rpc, programAddress);
    if (existing) {
      return [await this.read(programAddress), receipts];
    }

    const initData: MailboxInitData = {
      localDomain: this.config.domainId,
      defaultIsm: parseAddress(mailboxConfig.defaultIsm.deployed.address),
      maxProtocolFee: DEFAULT_MAX_PROTOCOL_FEE,
      protocolFee: {
        fee: DEFAULT_PROTOCOL_FEE,
        beneficiary: this.svmSigner.signer.address,
      },
    };

    const initIx = await buildInitMailboxInstruction(
      programAddress,
      this.svmSigner.signer,
      initData,
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

    // Ownership is always set to signer at init time.
    // Ownership transfer is handled separately via update().
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { ...mailboxConfig, owner: this.svmSigner.signer.address },
        deployed: {
          address: programAddress,
          domainId: this.config.domainId,
        },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = parseAddress(artifact.deployed.address);
    const current = await this.read(programId);

    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update mailbox ${programId}: mailbox has no owner`,
    );

    const expected = artifact.config;
    const ownerAddress = parseAddress(current.config.owner);
    const txs: AnnotatedSvmTransaction[] = [];

    // Mirror warp/IGP writer ordering: upgrade before config mutations.
    // No `upgradingToVersion` ratchet needed — mailbox has no
    // version-gated config instructions today.
    if (hasProgramBytes(this.config.program)) {
      const upgradeResult = await prepareProgramUpgrade(
        programId,
        current.config.contractVersion,
        expected.contractVersion,
        this.config.program.programBytes,
        this.svmSigner,
        this.rpc,
        `mailbox ${programId}`,
      );
      txs.push(...(upgradeResult?.authorityTransactions ?? []));
    }

    // 1. Default ISM update
    const currentIsm = current.config.defaultIsm.deployed.address;
    const expectedIsm = expected.defaultIsm.deployed.address;
    if (!eqAddressSol(currentIsm, expectedIsm)) {
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          await buildSetDefaultIsmInstruction(
            programId,
            ownerAddress,
            parseAddress(expectedIsm),
          ),
        ],
        annotation: `Update mailbox ${programId}: set default ISM`,
      });
    }

    const expectedOwner = !isEmptyAddress(expected.owner)
      ? parseAddress(expected.owner)
      : null;

    // 2. Ownership transfer
    if (
      !eqOptionalAddress(current.config.owner, expected.owner, eqAddressSol)
    ) {
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          await buildTransferMailboxOwnershipInstruction(
            programId,
            ownerAddress,
            expectedOwner,
          ),
        ],
        annotation: `Update mailbox ${programId}: transfer ownership`,
      });
    }

    // 3. BPF upgrade authority — always last tx.
    // Skip when the program is immutable (no current authority). Mirrors
    // SvmCollateralTokenWriter so a `core apply` ownership transfer also
    // moves the executable-upgrade authority, instead of leaving it with
    // the previous deployer.
    const currentUpgradeAuthority = await getProgramUpgradeAuthority(
      this.rpc,
      programId,
    );
    if (
      currentUpgradeAuthority &&
      !eqOptionalAddress(
        currentUpgradeAuthority,
        expectedOwner ?? undefined,
        eqAddressSol,
      )
    ) {
      txs.push({
        feePayer: currentUpgradeAuthority,
        instructions: [
          await getSetUpgradeAuthorityInstruction(
            programId,
            currentUpgradeAuthority,
            expectedOwner,
          ),
        ],
        annotation: `Update mailbox ${programId}: ${expectedOwner ? 'transfer' : 'renounce'} upgrade authority`,
      });
    }

    return txs;
  }
}
