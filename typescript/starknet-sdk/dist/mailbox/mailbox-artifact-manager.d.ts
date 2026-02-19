import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactReader, ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { DeployedMailboxAddress, DeployedRawMailboxArtifact, IRawMailboxArtifactManager, MailboxType, RawMailboxArtifactConfigs } from '@hyperlane-xyz/provider-sdk/mailbox';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
export declare class StarknetMailboxArtifactManager implements IRawMailboxArtifactManager {
    private readonly chainMetadata;
    private readonly provider;
    constructor(chainMetadata: ChainMetadataForAltVM);
    readMailbox(address: string): Promise<DeployedRawMailboxArtifact>;
    createReader<T extends MailboxType>(type: T): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress>;
    createWriter<T extends MailboxType>(type: T, signer: ISigner<AnnotatedTx, TxReceipt>): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress>;
}
//# sourceMappingURL=mailbox-artifact-manager.d.ts.map