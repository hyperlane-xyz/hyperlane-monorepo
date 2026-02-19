import { AltVM, ChainMetadataForAltVM, ITransactionSubmitter, MinimumRequiredGasByAction, ProtocolProvider, SignerConfig, TransactionSubmitterConfig } from '@hyperlane-xyz/provider-sdk';
import { IProvider } from '@hyperlane-xyz/provider-sdk/altvm';
import { IRawHookArtifactManager } from '@hyperlane-xyz/provider-sdk/hook';
import { IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import { IRawMailboxArtifactManager } from '@hyperlane-xyz/provider-sdk/mailbox';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { IRawValidatorAnnounceArtifactManager } from '@hyperlane-xyz/provider-sdk/validator-announce';
export declare class StarknetProtocolProvider implements ProtocolProvider {
    createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider>;
    createSigner(chainMetadata: ChainMetadataForAltVM, config: SignerConfig): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>>;
    createSubmitter<TConfig extends TransactionSubmitterConfig>(_chainMetadata: ChainMetadataForAltVM, _config: TConfig): Promise<ITransactionSubmitter>;
    createIsmArtifactManager(chainMetadata: ChainMetadataForAltVM): IRawIsmArtifactManager;
    createHookArtifactManager(chainMetadata: ChainMetadataForAltVM, context?: {
        mailbox?: string;
    }): IRawHookArtifactManager;
    createMailboxArtifactManager(chainMetadata: ChainMetadataForAltVM): IRawMailboxArtifactManager;
    createValidatorAnnounceArtifactManager(chainMetadata: ChainMetadataForAltVM): IRawValidatorAnnounceArtifactManager | null;
    getMinGas(): MinimumRequiredGasByAction;
}
//# sourceMappingURL=protocol.d.ts.map