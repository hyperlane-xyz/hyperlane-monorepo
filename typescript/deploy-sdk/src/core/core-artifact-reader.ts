import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import { DerivedCoreConfig } from '@hyperlane-xyz/provider-sdk/core';
import { hookArtifactToDerivedConfig } from '@hyperlane-xyz/provider-sdk/hook';
import {
  DeployedMailboxAddress,
  DeployedMailboxArtifact,
  IRawMailboxArtifactManager,
  MailboxOnChain,
  mailboxArtifactToDerivedCoreConfig,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { Logger, rootLogger } from '@hyperlane-xyz/utils';

import { HookReader, createHookReader } from '../hook/hook-reader.js';
import {
  IsmReader,
  createIsmReader,
  ismArtifactToDerivedConfig,
} from '../ism/generic-ism.js';

/**
 * Core Artifact Reader - composite artifact reader that orchestrates mailbox, ISM, and hook readers.
 *
 * This implements the artifact API pattern at the "composite" level in deploy-sdk.
 * It takes a mailbox address and returns a fully expanded MailboxOnChain artifact with
 * all nested ISM and hook configurations read from the chain.
 *
 * Architecture:
 * - Raw level: IRawMailboxArtifactManager (protocol-specific, in radix-sdk, cosmos-sdk, etc.)
 * - Composite level: CoreArtifactReader (this class, in deploy-sdk)
 *
 * The raw mailbox reader returns UNDERIVED ISM/hook references (just addresses).
 * This composite reader expands them into full DEPLOYED artifacts with complete configs.
 */
export class CoreArtifactReader
  implements ArtifactReader<MailboxOnChain, DeployedMailboxAddress>
{
  protected readonly logger: Logger = rootLogger.child({
    module: CoreArtifactReader.name,
  });
  private readonly ismReader: IsmReader;
  protected readonly hookReader: HookReader;

  constructor(
    protected readonly mailboxArtifactManager: IRawMailboxArtifactManager,
    protected readonly chainMetadata: ChainMetadataForAltVM,
    protected readonly chainLookup: ChainLookup,
  ) {
    this.hookReader = createHookReader(this.chainMetadata, this.chainLookup);
    this.ismReader = createIsmReader(this.chainMetadata, this.chainLookup);
  }

  /**
   * Read mailbox configuration and expand all nested ISM/hook configs.
   *
   * Takes a mailbox address, reads the raw mailbox config (which has UNDERIVED ISM/hook references),
   * then recursively reads and expands all nested ISM and hook artifacts.
   *
   * @param mailboxAddress The deployed mailbox address
   * @returns Fully expanded mailbox artifact with all nested configs in DEPLOYED state
   */
  async read(mailboxAddress: string): Promise<DeployedMailboxArtifact> {
    // 1. Read raw mailbox config - returns UNDERIVED ISM/hook references (just addresses)
    const rawMailbox =
      await this.mailboxArtifactManager.readMailbox(mailboxAddress);

    // 2. Expand nested ISM and hooks using specialized readers
    // The readers handle type detection and recursive expansion automatically
    const [defaultIsmArtifact, defaultHookArtifact, requiredHookArtifact] =
      await Promise.all([
        this.ismReader.read(rawMailbox.config.defaultIsm.deployed.address),
        this.hookReader.read(rawMailbox.config.defaultHook.deployed.address),
        this.hookReader.read(rawMailbox.config.requiredHook.deployed.address),
      ]);

    // 3. Return fully expanded mailbox artifact
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: rawMailbox.config.owner,
        defaultIsm: defaultIsmArtifact, // Now DEPLOYED with full config
        defaultHook: defaultHookArtifact, // Now DEPLOYED with full config
        requiredHook: requiredHookArtifact, // Now DEPLOYED with full config
      },
      deployed: rawMailbox.deployed,
    };
  }

  /**
   * Backward compatibility method: convert deployed mailbox artifact to DerivedCoreConfig.
   *
   * This allows CoreArtifactReader to be used as a drop-in replacement for AltVMCoreReader.
   * Existing code expects the deriveCoreConfig() method returning DerivedCoreConfig format.
   *
   * @param mailboxAddress The deployed mailbox address
   * @returns DerivedCoreConfig in the legacy format
   */
  async deriveCoreConfig(mailboxAddress: string): Promise<DerivedCoreConfig> {
    const artifact = await this.read(mailboxAddress);

    return mailboxArtifactToDerivedCoreConfig(artifact, this.chainLookup, {
      ismArtifactToDerivedConfig,
      hookArtifactToDerivedConfig,
    });
  }
}
