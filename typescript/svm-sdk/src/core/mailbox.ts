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
import { resolveProgram } from '../deploy/resolve-program.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import {
  buildInitMailboxInstruction,
  buildSetDefaultIsmInstruction,
  buildTransferMailboxOwnershipInstruction,
  type MailboxInitData,
} from './mailbox-tx.js';
import {
  fetchMailboxInboxAccount,
  fetchMailboxOutboxAccount,
} from './mailbox-query.js';
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

    // On SVM the mailbox IS the merkle tree hook — return the mailbox
    // address for both defaultHook and requiredHook as UNDERIVED artifacts.
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
        computeUnits: 400_000,
        skipPreflight: true,
      }),
    );

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

    // 1. Default ISM update
    const currentIsm = current.config.defaultIsm.deployed.address;
    const expectedIsm = expected.defaultIsm.deployed.address;
    if (!eqAddressSol(currentIsm, expectedIsm)) {
      txs.push({
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

    // 2. Ownership transfer — always last
    if (
      !eqOptionalAddress(current.config.owner, expected.owner, eqAddressSol)
    ) {
      const expectedOwner = !isEmptyAddress(expected.owner)
        ? parseAddress(expected.owner)
        : null;
      txs.push({
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

    return txs;
  }
}
