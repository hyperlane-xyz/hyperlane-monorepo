import { type ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import type { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { type ArtifactDeployed, type ArtifactReader, type ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import type { DeployedMailboxAddress, IRawMailboxArtifactManager, MailboxType, RawMailboxArtifactConfigs } from '@hyperlane-xyz/provider-sdk/mailbox';
import type { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
export declare class StarknetMailboxArtifactManager implements IRawMailboxArtifactManager {
    private readonly provider;
    private readonly domainId;
    constructor(chainMetadata: ChainMetadataForAltVM);
    readMailbox(address: string): Promise<ArtifactDeployed<import("@hyperlane-xyz/provider-sdk/artifact").ConfigOnChain<import("@hyperlane-xyz/provider-sdk/mailbox").MailboxConfig>, DeployedMailboxAddress>>;
    createReader<T extends MailboxType>(_type: T): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress>;
    createWriter<T extends MailboxType>(_type: T, signer: ISigner<AnnotatedTx, TxReceipt>): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress>;
}
//# sourceMappingURL=mailbox-artifact-manager.d.ts.map