import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactOnChain,
  ArtifactState,
  isArtifactNew,
  isArtifactUnderived,
  toDeployedOrUndefined,
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
  DeployedMailboxAddress,
  DeployedMailboxArtifact,
  IRawMailboxArtifactManager,
  MailboxArtifactConfig,
  MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedValidatorAnnounceArtifact,
  IRawValidatorAnnounceArtifactManager,
  RawValidatorAnnounceConfig,
} from '@hyperlane-xyz/provider-sdk/validator-announce';
import { Logger, ZERO_ADDRESS_HEX_32, rootLogger } from '@hyperlane-xyz/utils';

import { createHookWriter } from '../hook/hook-writer.js';
import { IsmWriter, createIsmWriter } from '../ism/generic-ism-writer.js';

import { CoreArtifactReader } from './core-artifact-reader.js';

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
 * Orchestrates core deployment (mailbox, ISM, hooks, validator announce)
 * using the Artifact API. Extends CoreArtifactReader for read().
 *
 * Does not implement ArtifactWriter<MailboxArtifactConfig, DeployedMailboxAddress>
 * because create() returns a composite result (mailbox + validator announce) rather
 * than a single [ArtifactDeployed, TxReceipt[]] tuple. The update() signature does
 * conform to the standard pattern.
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

  private async getInitialHookArtifact(
    hookArtifact: Artifact<HookArtifactConfig, DeployedHookAddress>,
    _receipts: TxReceipt[],
    _placeholderRef: {
      artifact?: ArtifactOnChain<HookArtifactConfig, DeployedHookAddress>;
    },
  ): Promise<ArtifactOnChain<HookArtifactConfig, DeployedHookAddress>> {
    if (!isArtifactNew(hookArtifact)) {
      return hookArtifact;
    }

    return {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: ZERO_ADDRESS_HEX_32 },
    };
  }

  async create(artifact: ArtifactNew<MailboxArtifactConfig>): Promise<
    [
      {
        mailbox: DeployedMailboxArtifact;
        validatorAnnounce: DeployedValidatorAnnounceArtifact | null;
      },
      TxReceipt[],
    ]
  > {
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
      const [deployed, ismReceipts] = await this.ismWriter.create(
        config.defaultIsm,
      );
      allReceipts.push(...ismReceipts);
      onChainIsmArtifact = deployed;
      this.logger.info(
        `Default ISM deployed at ${deployed.deployed.address} on ${chainName}`,
      );
    } else {
      onChainIsmArtifact = config.defaultIsm;
    }

    // Step 2: Create mailbox with the ISM plus temporary hook placeholders.
    const mailboxWriter = this.mailboxArtifactManager.createWriter(
      'mailbox',
      this.signer,
    );

    // Hooks require the mailbox address for deployment (circular dependency),
    // so we create mailbox first, deploy hooks in Step 3, then update mailbox in Step 4.
    // Most protocols accept zero hooks for this bootstrap step; the Starknet
    // mailbox writer materializes a temporary noop hook when it sees zero hooks.
    const placeholderHookRef: {
      artifact?: ArtifactOnChain<HookArtifactConfig, DeployedHookAddress>;
    } = {};
    const initialMailboxArtifact: ArtifactNew<MailboxOnChain> = {
      artifactState: ArtifactState.NEW,
      config: {
        owner: this.signer.getSignerAddress(), // Signer owns initially; transferred in Step 4
        defaultIsm: onChainIsmArtifact,
        defaultHook: await this.getInitialHookArtifact(
          config.defaultHook,
          allReceipts,
          placeholderHookRef,
        ),
        requiredHook: await this.getInitialHookArtifact(
          config.requiredHook,
          allReceipts,
          placeholderHookRef,
        ),
      },
    };

    const [deployedMailbox, mailboxReceipts] = await mailboxWriter.create(
      initialMailboxArtifact,
    );
    allReceipts.push(...mailboxReceipts);
    const mailboxAddress = deployedMailbox.deployed.address;
    this.logger.info(`Mailbox deployed at ${mailboxAddress} on ${chainName}`);

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
    }

    let onChainRequiredHookArtifact: ArtifactOnChain<
      HookArtifactConfig,
      DeployedHookAddress
    >;
    if (isArtifactNew(config.requiredHook)) {
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
    }

    // Step 4: Update mailbox with hooks + transfer owner
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
      const receipt = await this.signer.sendAndConfirmTransaction(tx);
      allReceipts.push(receipt);
    }

    // Step 5: Deploy validator announce (if supported by protocol)
    let validatorAnnounceArtifact: DeployedValidatorAnnounceArtifact | null =
      null;
    if (this.validatorAnnounceArtifactManager) {
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
    return [
      {
        mailbox: updatedMailboxArtifact,
        validatorAnnounce: validatorAnnounceArtifact,
      },
      allReceipts,
    ];
  }

  /**
   * Returns mailbox update transactions for the caller to submit.
   * Note: may perform on-chain writes as a side effect when sub-components
   * (ISM, hooks) require fresh deployment via `create()`.
   */
  async update(
    expectedArtifact: ArtifactDeployed<
      MailboxArtifactConfig,
      DeployedMailboxAddress
    >,
  ): Promise<AnnotatedTx[]> {
    const { config: expectedConfig, deployed } = expectedArtifact;
    const { address: mailboxAddress } = deployed;
    const updateTxs: AnnotatedTx[] = [];

    // Read actual state (fully expanded)
    const currentArtifact = await this.read(mailboxAddress);
    const currentConfig = currentArtifact.config;

    // Extract current artifacts: DEPLOYED if expanded, undefined if UNDERIVED (zero-address)
    // Throws if UNDERIVED with non-zero address (unexpected state)
    const currentIsm = toDeployedOrUndefined(
      currentConfig.defaultIsm,
      'defaultIsm',
    );
    const currentDefaultHook = toDeployedOrUndefined(
      currentConfig.defaultHook,
      'defaultHook',
    );
    const currentRequiredHook = toDeployedOrUndefined(
      currentConfig.requiredHook,
      'requiredHook',
    );

    // Update ISM
    const { address: newIsmAddress, transactions: ismTxs } =
      await this.deployOrUpdateIsm(currentIsm, expectedConfig.defaultIsm);
    updateTxs.push(...ismTxs);

    // Update default hook
    const { address: newDefaultHookAddress, transactions: defaultHookTxs } =
      await this.deployOrUpdateHook(
        currentDefaultHook,
        expectedConfig.defaultHook,
        mailboxAddress,
      );
    updateTxs.push(...defaultHookTxs);

    // Update required hook
    const { address: newRequiredHookAddress, transactions: requiredHookTxs } =
      await this.deployOrUpdateHook(
        currentRequiredHook,
        expectedConfig.requiredHook,
        mailboxAddress,
      );
    updateTxs.push(...requiredHookTxs);

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

  private async deployOrUpdateIsm(
    currentIsmArtifact: DeployedIsmArtifact | undefined,
    expectedIsm: Artifact<IsmArtifactConfig, DeployedIsmAddress>,
  ): Promise<{ address: string; transactions: AnnotatedTx[] }> {
    const chainName = this.chainMetadata.name;

    // If expected is UNDERIVED (just an address reference), use as-is
    if (isArtifactUnderived(expectedIsm)) {
      return { address: expectedIsm.deployed.address, transactions: [] };
    }

    // Merge current with expected (preserves DEPLOYED state for unchanged nested ISMs)
    const mergedArtifact = mergeIsmArtifacts(currentIsmArtifact, expectedIsm);

    if (isArtifactNew(mergedArtifact)) {
      const [deployed] = await this.ismWriter.create(mergedArtifact);
      this.logger.info(
        `ISM deployed at ${deployed.deployed.address} on ${chainName}`,
      );
      return { address: deployed.deployed.address, transactions: [] };
    }

    const updateTxs = await this.ismWriter.update(mergedArtifact);
    return {
      address: mergedArtifact.deployed.address,
      transactions: updateTxs,
    };
  }

  private async deployOrUpdateHook(
    currentHookArtifact: DeployedHookArtifact | undefined,
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
      const [deployed] = await hookWriter.create(mergedArtifact);
      this.logger.info(
        `Hook deployed at ${deployed.deployed.address} on ${chainName}`,
      );
      return { address: deployed.deployed.address, transactions: [] };
    }

    const updateTxs = await hookWriter.update(mergedArtifact);
    return {
      address: mergedArtifact.deployed.address,
      transactions: updateTxs,
    };
  }
}
