import { type ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import type { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedMailboxAddress,
  IRawMailboxArtifactManager,
  MailboxOnChain,
  MailboxType,
  RawMailboxArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import type {
  AnnotatedTx,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { ZERO_ADDRESS_HEX_32, eqAddressStarknet } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import type { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddress } from '../contracts.js';

class StarknetMailboxReader
  implements ArtifactReader<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(private readonly provider: StarknetProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>> {
    const mailbox = await this.provider.getMailbox({ mailboxAddress: address });

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: mailbox.owner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailbox.defaultIsm || ZERO_ADDRESS_HEX_32,
          },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailbox.defaultHook || ZERO_ADDRESS_HEX_32,
          },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailbox.requiredHook || ZERO_ADDRESS_HEX_32,
          },
        },
      },
      deployed: {
        address: mailbox.address,
        domainId: mailbox.localDomain,
      },
    };
  }
}

class StarknetMailboxWriter
  extends StarknetMailboxReader
  implements ArtifactWriter<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
    private readonly domainId: number,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<MailboxOnChain>,
  ): Promise<
    [ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>, TxReceipt[]]
  > {
    const created = await this.signer.createMailbox({
      domainId: this.domainId,
      defaultIsmAddress: artifact.config.defaultIsm.deployed.address,
    });

    await this.signer.setDefaultHook({
      mailboxAddress: created.mailboxAddress,
      hookAddress: artifact.config.defaultHook.deployed.address,
    });
    await this.signer.setRequiredHook({
      mailboxAddress: created.mailboxAddress,
      hookAddress: artifact.config.requiredHook.deployed.address,
    });
    if (
      !eqAddressStarknet(artifact.config.owner, this.signer.getSignerAddress())
    ) {
      await this.signer.setMailboxOwner({
        mailboxAddress: created.mailboxAddress,
        newOwner: artifact.config.owner,
      });
    }

    const deployedArtifact: ArtifactDeployed<
      MailboxOnChain,
      DeployedMailboxAddress
    > = await this.read(created.mailboxAddress);

    return [deployedArtifact, []];
  }

  async update(
    artifact: ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>,
  ): Promise<AnnotatedTx[]> {
    const current = await this.read(artifact.deployed.address);
    const txs: AnnotatedTx[] = [];

    if (
      !eqAddressStarknet(
        current.config.defaultIsm.deployed.address,
        artifact.config.defaultIsm.deployed.address,
      )
    ) {
      txs.push({
        annotation: `Updating mailbox default ISM`,
        ...(await this.signer.getSetDefaultIsmTransaction({
          signer: this.signer.getSignerAddress(),
          mailboxAddress: artifact.deployed.address,
          ismAddress: normalizeStarknetAddress(
            artifact.config.defaultIsm.deployed.address,
          ),
        })),
      });
    }

    if (
      !eqAddressStarknet(
        current.config.defaultHook.deployed.address,
        artifact.config.defaultHook.deployed.address,
      )
    ) {
      txs.push({
        annotation: `Updating mailbox default hook`,
        ...(await this.signer.getSetDefaultHookTransaction({
          signer: this.signer.getSignerAddress(),
          mailboxAddress: artifact.deployed.address,
          hookAddress: normalizeStarknetAddress(
            artifact.config.defaultHook.deployed.address,
          ),
        })),
      });
    }

    if (
      !eqAddressStarknet(
        current.config.requiredHook.deployed.address,
        artifact.config.requiredHook.deployed.address,
      )
    ) {
      txs.push({
        annotation: `Updating mailbox required hook`,
        ...(await this.signer.getSetRequiredHookTransaction({
          signer: this.signer.getSignerAddress(),
          mailboxAddress: artifact.deployed.address,
          hookAddress: normalizeStarknetAddress(
            artifact.config.requiredHook.deployed.address,
          ),
        })),
      });
    }

    if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
      txs.push({
        annotation: `Updating mailbox owner`,
        ...(await this.signer.getSetMailboxOwnerTransaction({
          signer: this.signer.getSignerAddress(),
          mailboxAddress: artifact.deployed.address,
          newOwner: normalizeStarknetAddress(artifact.config.owner),
        })),
      });
    }

    return txs;
  }
}

export class StarknetMailboxArtifactManager
  implements IRawMailboxArtifactManager
{
  private readonly provider: StarknetProvider;
  private readonly domainId: number;

  constructor(chainMetadata: ChainMetadataForAltVM) {
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map((rpc: { http: string }) => rpc.http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
    this.domainId = chainMetadata.domainId;
  }

  async readMailbox(address: string) {
    const reader = this.createReader('mailbox');
    return reader.read(address);
  }

  createReader<T extends MailboxType>(
    _type: T,
  ): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    return new StarknetMailboxReader(this.provider) as ArtifactReader<
      RawMailboxArtifactConfigs[T],
      DeployedMailboxAddress
    >;
  }

  createWriter<T extends MailboxType>(
    _type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    return new StarknetMailboxWriter(
      this.provider,
      signer as StarknetSigner,
      this.domainId,
    ) as ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress>;
  }
}
