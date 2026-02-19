import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactReader, ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { DeployedIsmAddress, DeployedRawIsmArtifact, IRawIsmArtifactManager, IsmType, RawIsmArtifactConfigs } from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
export declare class StarknetIsmArtifactManager implements IRawIsmArtifactManager {
    private readonly provider;
    constructor(chainMetadata: ChainMetadataForAltVM);
    readIsm(address: string): Promise<DeployedRawIsmArtifact>;
    createReader<T extends IsmType>(type: T): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress>;
    createWriter<T extends IsmType>(type: T, signer: ISigner<AnnotatedTx, TxReceipt>): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress>;
}
//# sourceMappingURL=ism-artifact-manager.d.ts.map