import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactNew,
  ArtifactOnChain,
  ArtifactState,
  isArtifactDeployed,
  isArtifactNew,
  isArtifactUnderived,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DeployedHookAddress,
  DeployedHookArtifact,
  HookArtifactConfig,
  mergeHookArtifacts,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  DeployedIsmAddress,
  DeployedIsmArtifact,
  IsmArtifactConfig,
  mergeIsmArtifacts,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  DeployedMailboxArtifact,
  IRawMailboxArtifactManager,
  MailboxConfig,
  MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedValidatorAnnounceArtifact,
  IRawValidatorAnnounceArtifactManager,
  RawValidatorAnnounceConfig,
} from '@hyperlane-xyz/provider-sdk/validator-announce';
import {
  Logger,
  ZERO_ADDRESS_HEX_32,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { createHookWriter } from '../hook/hook-writer.js';
import { IsmWriter, createIsmWriter } from '../ism/generic-ism-writer.js';

import { CoreArtifactReader } from './core-artifact-reader.js';

/**
 * Factory function to create a CoreWriter instance.
 * Follows pattern of createHookWriter() and createIsmWriter().
 *
 * @param chainMetadata Chain metadata for target chain
 * @param chainLookup Chain lookup for domain resolution
 * @param signer Signer for transaction signing
 * @returns CoreWriter instance
 *
 * @example
 * ```typescript
 * const writer = createCoreWriter(chainMetadata, chainLookup, signer);
 * const { mailbox, validatorAnnounce } = await writer.create(coreArtifact);
 * ```
 */
export function createCoreWriter(
  chainMetadata: ChainMetadataForAltVM,
  chainLookup: ChainLookup,
  signer: ISigner<AnnotatedTx, TxReceipt>,
): CoreWriter {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);

  const mailboxArtifactManager =
    protocolProvider.createMailboxArtifactManager(chainMetadata);

  const validatorAnnounceArtifactManager =
    protocolProvider.createValidatorAnnounceArtifactManager(chainMetadata);

  return new CoreWriter(
    mailboxArtifactManager,
    validatorAnnounceArtifactManager,
    chainMetadata,
    chainLookup,
    signer,
  );
}

/**
 * CoreWriter orchestrates full core deployment using the Artifact API.
 * Handles mailbox, ISM, hook, and validator announce deployment.
 *
 * Extends CoreArtifactReader to inherit read() functionality.
 * Follows same pattern as HookWriter, IsmWriter, and WarpTokenWriter.
 *
 * Deployment flow:
 * 1. Deploy ISM if NEW (via IsmWriter)
 * 2. Create Mailbox with ISM + zero hooks (via mailboxWriter)
 * 3. Deploy hooks if NEW with mailbox context (via HookWriter)
 * 4. Update mailbox with hooks + owner (via mailboxWriter.update + signer)
 * 5. Deploy validator announce (via vaWriter)
 */
export class CoreWriter extends CoreArtifactReader {
  protected readonly logger: Logger = rootLogger.child({
    module: CoreWriter.name,
  });

  private readonly ismWriter: IsmWriter;

  constructor(
    mailboxArtifactManager: IRawMailboxArtifactManager,
    protected readonly validatorAnnounceArtifactManager: IRawValidatorAnnounceArtifactManager | null,
    chainMetadata: ChainMetadataForAltVM,
    chainLookup: ChainLookup,
    protected readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(mailboxArtifactManager, chainMetadata, chainLookup);

    this.ismWriter = createIsmWriter(
      this.chainMetadata,
      this.chainLookup,
      this.signer,
    );
  }

  /**
   * Deploys full core contracts: ISM, hooks, mailbox, validator announce.
   *
   * @param artifact Mailbox artifact with nested ISM and hook artifacts
   * @returns Object containing deployed mailbox, validator announce artifacts, and receipts
   */
  async create(artifact: ArtifactNew<MailboxConfig>): Promise<{
    mailbox: DeployedMailboxArtifact;
    validatorAnnounce: DeployedValidatorAnnounceArtifact | null;
    receipts: TxReceipt[];
  }> {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];
    const chainName = this.chainMetadata.name;

    this.logger.info(`Starting core deployment on ${chainName}`);

    // Step 1: Deploy ISM if NEW
    let onChainIsmArtifact: ArtifactOnChain<
      IsmArtifactConfig,
      DeployedIsmAddress
    >;
    if (isArtifactNew(config.defaultIsm)) {
      this.logger.info(`Deploying default ISM on ${chainName}`);
      const [deployed, ismReceipts] = await this.ismWriter.create(
        config.defaultIsm,
      );
      allReceipts.push(...ismReceipts);
      onChainIsmArtifact = deployed;
      this.logger.info(
        `Default ISM deployed at ${deployed.deployed.address} on ${chainName}`,
      );
    } else {
      // DEPLOYED or UNDERIVED - use as-is
      onChainIsmArtifact = config.defaultIsm;
      this.logger.info(
        `Using existing ISM at ${config.defaultIsm.deployed.address} for core deployment on ${chainName}`,
      );
    }

    // Step 2: Create mailbox with ISM + zero hooks initially
    this.logger.info(`Creating mailbox on ${chainName}`);
    const mailboxWriter = this.mailboxArtifactManager.createWriter(
      'mailbox',
      this.signer,
    );

    // Create mailbox with ISM but zero hooks initially.
    // Hooks require the mailbox address for deployment (circular dependency),
    // so we create mailbox first, deploy hooks in Step 3, then update mailbox in Step 4.
    const initialMailboxArtifact: ArtifactNew<MailboxOnChain> = {
      artifactState: ArtifactState.NEW,
      config: {
        owner: this.signer.getSignerAddress(), // Initial owner (will transfer later)
        defaultIsm: onChainIsmArtifact,
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ZERO_ADDRESS_HEX_32 },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ZERO_ADDRESS_HEX_32 },
        },
      },
    };

    const [deployedMailbox, mailboxReceipts] = await mailboxWriter.create(
      initialMailboxArtifact,
    );
    allReceipts.push(...mailboxReceipts);
    const mailboxAddress = deployedMailbox.deployed.address;
    this.logger.info(`Mailbox created at ${mailboxAddress} on ${chainName}`);

    const hookWriter = createHookWriter(
      this.chainMetadata,
      this.chainLookup,
      this.signer,
      { mailbox: mailboxAddress },
    );

    // Step 3: Deploy hooks if NEW (hooks need mailbox address)
    let onChainDefaultHookArtifact: ArtifactOnChain<
      HookArtifactConfig,
      DeployedHookAddress
    >;
    if (isArtifactNew(config.defaultHook)) {
      this.logger.info(`Deploying default hook on ${chainName}`);

      const [deployed, hookReceipts] = await hookWriter.create(
        config.defaultHook,
      );
      allReceipts.push(...hookReceipts);
      onChainDefaultHookArtifact = deployed;
      this.logger.info(
        `Default hook deployed at ${deployed.deployed.address} on ${chainName}`,
      );
    } else {
      onChainDefaultHookArtifact = config.defaultHook;
      this.logger.info(
        `Using existing default hook at ${config.defaultHook.deployed.address} for core deployment on ${chainName}`,
      );
    }

    let onChainRequiredHookArtifact: ArtifactOnChain<
      HookArtifactConfig,
      DeployedHookAddress
    >;
    if (isArtifactNew(config.requiredHook)) {
      this.logger.info(`Deploying required hook on ${chainName}`);

      const [deployed, hookReceipts] = await hookWriter.create(
        config.requiredHook,
      );
      allReceipts.push(...hookReceipts);
      onChainRequiredHookArtifact = deployed;
      this.logger.info(
        `Required hook deployed at ${deployed.deployed.address} on ${chainName}`,
      );
    } else {
      onChainRequiredHookArtifact = config.requiredHook;
      this.logger.info(
        `Using existing required hook at ${config.requiredHook.deployed.address} for core deployment on ${chainName}`,
      );
    }

    // Step 4: Update mailbox with hooks + transfer owner
    this.logger.info(`Updating mailbox configuration on ${chainName}`);
    const updatedMailboxArtifact: DeployedMailboxArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: config.owner,
        defaultIsm: onChainIsmArtifact,
        defaultHook: onChainDefaultHookArtifact,
        requiredHook: onChainRequiredHookArtifact,
      },
      deployed: deployedMailbox.deployed,
    };

    const updateTxs = await mailboxWriter.update(updatedMailboxArtifact);
    for (const tx of updateTxs) {
      this.logger.debug(
        `Executing update transaction on ${chainName}: ${tx.annotation}`,
      );
      const receipt = await this.signer.sendAndConfirmTransaction(tx);
      allReceipts.push(receipt);
    }

    // Step 5: Deploy validator announce (if supported by protocol)
    let validatorAnnounceArtifact: DeployedValidatorAnnounceArtifact | null =
      null;
    if (this.validatorAnnounceArtifactManager) {
      this.logger.info(`Deploying validator announce on ${chainName}`);
      const vaWriter = this.validatorAnnounceArtifactManager.createWriter(
        'validatorAnnounce',
        this.signer,
      );
      const vaArtifact: ArtifactNew<RawValidatorAnnounceConfig> = {
        artifactState: ArtifactState.NEW,
        config: { mailboxAddress },
      };
      const [deployed, vaReceipts] = await vaWriter.create(vaArtifact);
      allReceipts.push(...vaReceipts);
      validatorAnnounceArtifact = deployed;
      this.logger.info(
        `Validator announce deployed at ${deployed.deployed.address} on ${chainName}`,
      );
    } else {
      this.logger.info(
        `Validator announce not supported by protocol for ${chainName}`,
      );
    }

    this.logger.info(`Core deployment complete on ${chainName}`);
    return {
      mailbox: updatedMailboxArtifact,
      validatorAnnounce: validatorAnnounceArtifact,
      receipts: allReceipts,
    };
  }

  /**
   * Updates existing core deployment.
   *
   * @param mailboxAddress Existing mailbox address
   * @param expectedArtifact Expected mailbox artifact with nested ISM/hook artifacts
   * @returns Array of update transactions
   */
  async update(
    mailboxAddress: string,
    expectedArtifact: ArtifactNew<MailboxConfig>,
  ): Promise<AnnotatedTx[]> {
    const { config: expectedConfig } = expectedArtifact;
    const updateTxs: AnnotatedTx[] = [];
    const chainName = this.chainMetadata.name;

    this.logger.info(`Starting core update on ${chainName}`);

    // Read actual state (fully expanded)
    const currentArtifact = await this.read(mailboxAddress);
    const currentConfig = currentArtifact.config;

    // Verify that reader expanded all nested artifacts
    assert(
      isArtifactDeployed(currentConfig.defaultIsm),
      'Expected Core Reader to expand the ISM config',
    );
    assert(
      isArtifactDeployed(currentConfig.defaultHook),
      'Expected Core Reader to expand the default hook config',
    );
    assert(
      isArtifactDeployed(currentConfig.requiredHook),
      'Expected Core Reader to expand the required hook config',
    );

    // Update ISM
    const { address: newIsmAddress, transactions: ismTxs } =
      await this.deployOrUpdateIsm(
        currentConfig.defaultIsm,
        expectedConfig.defaultIsm,
      );
    updateTxs.push(...ismTxs);

    // Update default hook
    const { address: newDefaultHookAddress, transactions: defaultHookTxs } =
      await this.deployOrUpdateHook(
        currentConfig.defaultHook,
        expectedConfig.defaultHook,
        mailboxAddress,
      );
    updateTxs.push(...defaultHookTxs);

    // Update required hook
    const { address: newRequiredHookAddress, transactions: requiredHookTxs } =
      await this.deployOrUpdateHook(
        currentConfig.requiredHook,
        expectedConfig.requiredHook,
        mailboxAddress,
      );
    updateTxs.push(...requiredHookTxs);

    this.logger.info(`Updating mailbox configuration on ${chainName}`);

    const mailboxWriter = this.mailboxArtifactManager.createWriter(
      'mailbox',
      this.signer,
    );

    const updatedMailboxArtifact: DeployedMailboxArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: expectedConfig.owner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: newIsmAddress },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: newDefaultHookAddress },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: newRequiredHookAddress },
        },
      },
      deployed: currentArtifact.deployed,
    };

    const mailboxUpdateTxs = await mailboxWriter.update(updatedMailboxArtifact);
    updateTxs.push(...mailboxUpdateTxs);

    return updateTxs;
  }

  /**
   * Helper: Deploy or update ISM based on current vs expected.
   * Uses IsmWriter internally, follows merge pattern from WarpTokenWriter.
   */
  private async deployOrUpdateIsm(
    currentIsmArtifact: DeployedIsmArtifact,
    expectedIsm: Artifact<IsmArtifactConfig, DeployedIsmAddress>,
  ): Promise<{ address: string; transactions: AnnotatedTx[] }> {
    const chainName = this.chainMetadata.name;

    // If expected is UNDERIVED (just an address reference), use as-is
    if (isArtifactUnderived(expectedIsm)) {
      return { address: expectedIsm.deployed.address, transactions: [] };
    }

    const ismWriter = createIsmWriter(
      this.chainMetadata,
      this.chainLookup,
      this.signer,
    );

    // Merge current with expected (preserves DEPLOYED state for unchanged nested ISMs)
    const mergedArtifact = mergeIsmArtifacts(currentIsmArtifact, expectedIsm);

    if (isArtifactNew(mergedArtifact)) {
      // Deploy new ISM
      this.logger.info(`Deploying new ISM on ${chainName}`);
      const [deployed] = await ismWriter.create(mergedArtifact);
      this.logger.info(
        `New ISM deployed at ${deployed.deployed.address} on ${chainName}`,
      );
      return { address: deployed.deployed.address, transactions: [] };
    }

    // Update in-place
    this.logger.info(`Updating existing ISM on ${chainName}`);
    const updateTxs = await ismWriter.update(mergedArtifact);
    this.logger.info(
      `ISM update generated ${updateTxs.length} transactions on ${chainName}`,
    );
    return {
      address: mergedArtifact.deployed.address,
      transactions: updateTxs,
    };
  }

  /**
   * Helper: Deploy or update hook based on current vs expected.
   * Uses HookWriter internally, follows merge pattern from WarpTokenWriter.
   */
  private async deployOrUpdateHook(
    currentHookArtifact: DeployedHookArtifact,
    expectedHook: Artifact<HookArtifactConfig, DeployedHookAddress>,
    mailboxAddress: string,
  ): Promise<{ address: string; transactions: AnnotatedTx[] }> {
    const chainName = this.chainMetadata.name;

    // If expected is UNDERIVED (just an address reference), use as-is
    if (isArtifactUnderived(expectedHook)) {
      return { address: expectedHook.deployed.address, transactions: [] };
    }

    const hookWriter = createHookWriter(
      this.chainMetadata,
      this.chainLookup,
      this.signer,
      { mailbox: mailboxAddress },
    );

    // Merge current with expected
    const mergedArtifact = mergeHookArtifacts(
      currentHookArtifact,
      expectedHook,
    );

    if (isArtifactNew(mergedArtifact)) {
      // Deploy new hook
      this.logger.info(`Deploying new hook on ${chainName}`);
      const [deployed] = await hookWriter.create(mergedArtifact);
      this.logger.info(
        `New hook deployed at ${deployed.deployed.address} on ${chainName}`,
      );
      return { address: deployed.deployed.address, transactions: [] };
    }

    // Update in-place
    this.logger.info(`Updating existing hook on ${chainName}`);
    const updateTxs = await hookWriter.update(mergedArtifact);
    this.logger.info(
      `Hook update generated ${updateTxs.length} transactions on ${chainName}`,
    );
    return {
      address: mergedArtifact.deployed.address,
      transactions: updateTxs,
    };
  }
}
