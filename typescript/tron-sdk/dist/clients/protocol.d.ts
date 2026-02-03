import { AltVM, ChainMetadataForAltVM, ITransactionSubmitter, MinimumRequiredGasByAction, ProtocolProvider, SignerConfig, TransactionSubmitterConfig } from '@hyperlane-xyz/provider-sdk';
import { IProvider } from '@hyperlane-xyz/provider-sdk/altvm';
import { IRawHookArtifactManager } from '@hyperlane-xyz/provider-sdk/hook';
import { IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
/**
 * TronProtocolProvider implements the ProtocolProvider interface for Tron.
 * This enables Tron to be registered with the protocol registry and used
 * by the CLI and deploy tooling.
 */
export declare class TronProtocolProvider implements ProtocolProvider {
    createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider>;
    createSigner(chainMetadata: ChainMetadataForAltVM, config: SignerConfig): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>>;
    createSubmitter<TConfig extends TransactionSubmitterConfig>(_chainMetadata: ChainMetadataForAltVM, _config: TConfig): Promise<ITransactionSubmitter>;
    createIsmArtifactManager(_chainMetadata: ChainMetadataForAltVM): IRawIsmArtifactManager;
    createHookArtifactManager(_chainMetadata: ChainMetadataForAltVM, _context?: {
        mailbox?: string;
    }): IRawHookArtifactManager;
    getMinGas(): MinimumRequiredGasByAction;
}
//# sourceMappingURL=protocol.d.ts.map