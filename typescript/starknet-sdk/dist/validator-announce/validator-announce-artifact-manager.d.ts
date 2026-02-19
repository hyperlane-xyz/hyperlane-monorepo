import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { ArtifactReader, ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { DeployedRawValidatorAnnounceArtifact, DeployedValidatorAnnounceAddress, IRawValidatorAnnounceArtifactManager, RawValidatorAnnounceArtifactConfigs, ValidatorAnnounceType } from '@hyperlane-xyz/provider-sdk/validator-announce';
export declare class StarknetValidatorAnnounceArtifactManager implements IRawValidatorAnnounceArtifactManager {
    constructor(_chainMetadata: ChainMetadataForAltVM);
    readValidatorAnnounce(address: string): Promise<DeployedRawValidatorAnnounceArtifact>;
    createReader<T extends ValidatorAnnounceType>(type: T): ArtifactReader<RawValidatorAnnounceArtifactConfigs[T], DeployedValidatorAnnounceAddress>;
    createWriter<T extends ValidatorAnnounceType>(type: T, signer: ISigner<AnnotatedTx, TxReceipt>): ArtifactWriter<RawValidatorAnnounceArtifactConfigs[T], DeployedValidatorAnnounceAddress>;
}
//# sourceMappingURL=validator-announce-artifact-manager.d.ts.map