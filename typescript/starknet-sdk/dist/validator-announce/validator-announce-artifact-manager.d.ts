import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import type { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import { type ArtifactDeployed, type ArtifactReader, type ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import type { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import type { DeployedValidatorAnnounceAddress, IRawValidatorAnnounceArtifactManager, RawValidatorAnnounceArtifactConfigs, ValidatorAnnounceType } from '@hyperlane-xyz/provider-sdk/validator-announce';
export declare class StarknetValidatorAnnounceArtifactManager implements IRawValidatorAnnounceArtifactManager {
    constructor(chainMetadata: ChainMetadataForAltVM);
    readValidatorAnnounce(address: string): Promise<ArtifactDeployed<import("@hyperlane-xyz/provider-sdk/validator-announce").RawValidatorAnnounceConfig, DeployedValidatorAnnounceAddress>>;
    createReader<T extends ValidatorAnnounceType>(_type: T): ArtifactReader<RawValidatorAnnounceArtifactConfigs[T], DeployedValidatorAnnounceAddress>;
    createWriter<T extends ValidatorAnnounceType>(_type: T, signer: ISigner<AnnotatedTx, TxReceipt>): ArtifactWriter<RawValidatorAnnounceArtifactConfigs[T], DeployedValidatorAnnounceAddress>;
}
//# sourceMappingURL=validator-announce-artifact-manager.d.ts.map