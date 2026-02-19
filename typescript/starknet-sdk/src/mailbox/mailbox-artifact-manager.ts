import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedMailboxAddress,
  DeployedRawMailboxArtifact,
  IRawMailboxArtifactManager,
  MailboxType,
  RawMailboxArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { ZERO_ADDRESS_HEX_32, eqAddressStarknet, assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { StarknetAnnotatedTx } from '../types.js';

class StarknetMailboxReader
  implements
    ArtifactReader<
      RawMailboxArtifactConfigs['mailbox'],
      DeployedMailboxAddress
    >
{
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawMailboxArtifactConfigs['mailbox'],
      DeployedMailboxAddress
    >
  > {
    const mailbox = await this.provider.getMailbox({ mailboxAddress: address });

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: mailbox.owner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: normalizeStarknetAddressSafe(mailbox.defaultIsm) },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: normalizeStarknetAddressSafe(mailbox.defaultHook) },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: normalizeStarknetAddressSafe(mailbox.requiredHook) },
        },
      },
      deployed: {
        address: normalizeStarknetAddressSafe(mailbox.address),
        domainId: mailbox.localDomain,
      },
    };
  }
}

class StarknetMailboxWriter
  extends StarknetMailboxReader
  implements
    ArtifactWriter<
      RawMailboxArtifactConfigs['mailbox'],
      DeployedMailboxAddress
    >
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
    private readonly chainMetadata: ChainMetadataForAltVM,
  ) {
    super(provider);
  }

  private getNestedAddress(nested: { deployed: { address: string } }): string {
    return normalizeStarknetAddressSafe(nested.deployed.address);
  }

  async create(
    artifact: ArtifactNew<RawMailboxArtifactConfigs['mailbox']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawMailboxArtifactConfigs['mailbox'],
        DeployedMailboxAddress
      >,
      TxReceipt[],
    ]
  > {
    const defaultIsmAddress = this.getNestedAddress(artifact.config.defaultIsm);
    const defaultHookAddress = this.getNestedAddress(artifact.config.defaultHook);
    const requiredHookAddress = this.getNestedAddress(artifact.config.requiredHook);

    const receipts: TxReceipt[] = [];

    const createTx = await this.signer.getCreateMailboxTransaction({
      signer: this.signer.getSignerAddress(),
      domainId: this.chainMetadata.domainId,
      defaultIsmAddress,
      proxyAdminAddress: undefined,
    });
    const createReceipt = await this.signer.sendAndConfirmTransaction(
      createTx as StarknetAnnotatedTx,
    );
    receipts.push(createReceipt);

    assert(createReceipt.contractAddress, 'failed to deploy Starknet mailbox');
    const mailboxAddress = createReceipt.contractAddress;

    if (!eqAddressStarknet(defaultHookAddress, ZERO_ADDRESS_HEX_32)) {
      const tx = await this.signer.getSetDefaultHookTransaction({
        signer: this.signer.getSignerAddress(),
        mailboxAddress,
        hookAddress: defaultHookAddress,
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(tx as StarknetAnnotatedTx));
    }

    if (!eqAddressStarknet(requiredHookAddress, ZERO_ADDRESS_HEX_32)) {
      const tx = await this.signer.getSetRequiredHookTransaction({
        signer: this.signer.getSignerAddress(),
        mailboxAddress,
        hookAddress: requiredHookAddress,
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(tx as StarknetAnnotatedTx));
    }

    if (!eqAddressStarknet(artifact.config.owner, this.signer.getSignerAddress())) {
      const tx = await this.signer.getSetMailboxOwnerTransaction({
        signer: this.signer.getSignerAddress(),
        mailboxAddress,
        newOwner: artifact.config.owner,
      });
      receipts.push(await this.signer.sendAndConfirmTransaction(tx as StarknetAnnotatedTx));
    }

    const deployed = await this.read(mailboxAddress);
    return [deployed, receipts];
  }

  async update(
    artifact: ArtifactDeployed<
      RawMailboxArtifactConfigs['mailbox'],
      DeployedMailboxAddress
    >,
  ): Promise<AnnotatedTx[]> {
    const current = await this.read(artifact.deployed.address);
    const mailboxAddress = artifact.deployed.address;
    const updateTxs: AnnotatedTx[] = [];

    const expectedDefaultIsm = this.getNestedAddress(artifact.config.defaultIsm);
    const expectedDefaultHook = this.getNestedAddress(artifact.config.defaultHook);
    const expectedRequiredHook = this.getNestedAddress(artifact.config.requiredHook);

    const currentDefaultIsm = this.getNestedAddress(current.config.defaultIsm);
    const currentDefaultHook = this.getNestedAddress(current.config.defaultHook);
    const currentRequiredHook = this.getNestedAddress(current.config.requiredHook);

    if (!eqAddressStarknet(currentDefaultIsm, expectedDefaultIsm)) {
      updateTxs.push({
        annotation: `Setting mailbox default ISM`,
        ...(await this.signer.getSetDefaultIsmTransaction({
          signer: this.signer.getSignerAddress(),
          mailboxAddress,
          ismAddress: expectedDefaultIsm,
        })),
      });
    }

    if (!eqAddressStarknet(currentDefaultHook, expectedDefaultHook)) {
      updateTxs.push({
        annotation: `Setting mailbox default hook`,
        ...(await this.signer.getSetDefaultHookTransaction({
          signer: this.signer.getSignerAddress(),
          mailboxAddress,
          hookAddress: expectedDefaultHook,
        })),
      });
    }

    if (!eqAddressStarknet(currentRequiredHook, expectedRequiredHook)) {
      updateTxs.push({
        annotation: `Setting mailbox required hook`,
        ...(await this.signer.getSetRequiredHookTransaction({
          signer: this.signer.getSignerAddress(),
          mailboxAddress,
          hookAddress: expectedRequiredHook,
        })),
      });
    }

    if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
      updateTxs.push({
        annotation: `Setting mailbox owner`,
        ...(await this.signer.getSetMailboxOwnerTransaction({
          signer: this.signer.getSignerAddress(),
          mailboxAddress,
          newOwner: artifact.config.owner,
        })),
      });
    }

    return updateTxs;
  }
}

export class StarknetMailboxArtifactManager implements IRawMailboxArtifactManager {
  private readonly provider: StarknetProvider;

  constructor(private readonly chainMetadata: ChainMetadataForAltVM) {
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map(({ http }) => http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
  }

  readMailbox(address: string): Promise<DeployedRawMailboxArtifact> {
    return this.createReader('mailbox').read(address) as Promise<DeployedRawMailboxArtifact>;
  }

  createReader<T extends MailboxType>(
    type: T,
  ): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    if (type !== 'mailbox') {
      throw new Error(`Unsupported Starknet mailbox type: ${type}`);
    }
    return new StarknetMailboxReader(this.provider) as ArtifactReader<
      RawMailboxArtifactConfigs[T],
      DeployedMailboxAddress
    >;
  }

  createWriter<T extends MailboxType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    if (type !== 'mailbox') {
      throw new Error(`Unsupported Starknet mailbox type: ${type}`);
    }

    return new StarknetMailboxWriter(
      this.provider,
      signer as StarknetSigner,
      this.chainMetadata,
    ) as ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress>;
  }
}
