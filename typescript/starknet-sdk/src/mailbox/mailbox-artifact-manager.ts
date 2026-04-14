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
import {
  assert,
  eqAddressStarknet,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { getCreateNoopHookTx } from '../hook/hook-tx.js';
import {
  getCreateMailboxTx,
  getSetDefaultHookTx,
  getSetDefaultIsmTx,
  getSetMailboxOwnerTx,
  getSetRequiredHookTx,
} from './mailbox-tx.js';

class StarknetMailboxReader implements ArtifactReader<
  RawMailboxArtifactConfigs['mailbox'],
  DeployedMailboxAddress
> {
  constructor(protected readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawMailboxArtifactConfigs['mailbox'],
      DeployedMailboxAddress
    >
  > {
    const mailbox = await this.provider.getMailbox({
      mailboxAddress: address,
    });

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: mailbox.owner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: normalizeStarknetAddressSafe(mailbox.defaultIsm),
          },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: normalizeStarknetAddressSafe(mailbox.defaultHook),
          },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: normalizeStarknetAddressSafe(mailbox.requiredHook),
          },
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
    ArtifactWriter<RawMailboxArtifactConfigs['mailbox'], DeployedMailboxAddress>
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

  private async getInitialHookAddress(
    address: string,
    receipts: TxReceipt[],
    placeholderRef: { address?: string },
  ): Promise<string> {
    if (!isZeroishAddress(address)) {
      return normalizeStarknetAddressSafe(address);
    }

    if (!placeholderRef.address) {
      const tx = getCreateNoopHookTx();
      const receipt = await this.signer.sendAndConfirmTransaction(tx);
      receipts.push(receipt);
      assert(
        receipt.contractAddress,
        'failed to deploy placeholder Starknet noop hook',
      );
      placeholderRef.address = normalizeStarknetAddressSafe(
        receipt.contractAddress,
      );
    }

    return placeholderRef.address;
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

    const receipts: TxReceipt[] = [];
    const placeholderHookRef: { address?: string } = {};
    const defaultHookAddress = await this.getInitialHookAddress(
      this.getNestedAddress(artifact.config.defaultHook),
      receipts,
      placeholderHookRef,
    );
    const requiredHookAddress = await this.getInitialHookAddress(
      this.getNestedAddress(artifact.config.requiredHook),
      receipts,
      placeholderHookRef,
    );

    const createTx = getCreateMailboxTx({
      signer: this.signer.getSignerAddress(),
      domainId: this.chainMetadata.domainId,
      defaultIsmAddress,
      defaultHookAddress,
      requiredHookAddress,
    });
    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    receipts.push(createReceipt);

    assert(createReceipt.contractAddress, 'failed to deploy Starknet mailbox');
    const mailboxAddress = createReceipt.contractAddress;

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: {
          address: normalizeStarknetAddressSafe(mailboxAddress),
          domainId: this.chainMetadata.domainId,
        },
      },
      receipts,
    ];
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

    const expectedDefaultIsm = this.getNestedAddress(
      artifact.config.defaultIsm,
    );
    const expectedDefaultHook = this.getNestedAddress(
      artifact.config.defaultHook,
    );
    const expectedRequiredHook = this.getNestedAddress(
      artifact.config.requiredHook,
    );

    const currentDefaultIsm = this.getNestedAddress(current.config.defaultIsm);
    const currentDefaultHook = this.getNestedAddress(
      current.config.defaultHook,
    );
    const currentRequiredHook = this.getNestedAddress(
      current.config.requiredHook,
    );

    const rawProvider = this.signer.getRawProvider();

    if (!eqAddressStarknet(currentDefaultIsm, expectedDefaultIsm)) {
      updateTxs.push({
        annotation: `Setting mailbox default ISM`,
        ...(await getSetDefaultIsmTx(rawProvider, {
          signer: this.signer.getSignerAddress(),
          mailboxAddress,
          ismAddress: expectedDefaultIsm,
        })),
      });
    }

    if (!eqAddressStarknet(currentDefaultHook, expectedDefaultHook)) {
      updateTxs.push({
        annotation: `Setting mailbox default hook`,
        ...(await getSetDefaultHookTx(rawProvider, {
          signer: this.signer.getSignerAddress(),
          mailboxAddress,
          hookAddress: expectedDefaultHook,
        })),
      });
    }

    if (!eqAddressStarknet(currentRequiredHook, expectedRequiredHook)) {
      updateTxs.push({
        annotation: `Setting mailbox required hook`,
        ...(await getSetRequiredHookTx(rawProvider, {
          signer: this.signer.getSignerAddress(),
          mailboxAddress,
          hookAddress: expectedRequiredHook,
        })),
      });
    }

    if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
      updateTxs.push({
        annotation: `Setting mailbox owner`,
        ...(await getSetMailboxOwnerTx(rawProvider, {
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

  private requireStarknetSigner(
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): StarknetSigner {
    assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');
    return signer;
  }

  async readMailbox(address: string): Promise<DeployedRawMailboxArtifact> {
    return this.createReader('mailbox').read(address);
  }

  createReader<T extends MailboxType>(
    type: T,
  ): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    const readers: {
      [K in MailboxType]: ArtifactReader<
        RawMailboxArtifactConfigs[K],
        DeployedMailboxAddress
      >;
    } = {
      mailbox: new StarknetMailboxReader(this.provider),
    };
    const reader = readers[type];
    assert(reader, 'Unsupported Starknet mailbox type');
    return reader;
  }

  createWriter<T extends MailboxType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    const writerFactories: {
      [K in MailboxType]: () => ArtifactWriter<
        RawMailboxArtifactConfigs[K],
        DeployedMailboxAddress
      >;
    } = {
      mailbox: () =>
        new StarknetMailboxWriter(
          this.provider,
          this.requireStarknetSigner(signer),
          this.chainMetadata,
        ),
    };
    const writerFactory = writerFactories[type];
    assert(writerFactory, 'Unsupported Starknet mailbox type');
    return writerFactory();
  }
}
