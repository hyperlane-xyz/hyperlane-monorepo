import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactReader, ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { DeployedHookAddress, DeployedHookArtifact, HookType, IRawHookArtifactManager, RawHookArtifactConfigs } from '@hyperlane-xyz/provider-sdk/hook';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
export declare class StarknetHookArtifactManager implements IRawHookArtifactManager {
    private readonly chainMetadata;
    private readonly provider;
    private readonly mailboxAddress;
    constructor(chainMetadata: ChainMetadataForAltVM, context?: {
        mailbox?: string;
    });
    readHook(address: string): Promise<DeployedHookArtifact>;
    createReader<T extends HookType>(type: T): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress>;
    createWriter<T extends HookType>(type: T, signer: ISigner<AnnotatedTx, TxReceipt>): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress>;
}
//# sourceMappingURL=hook-artifact-manager.d.ts.map