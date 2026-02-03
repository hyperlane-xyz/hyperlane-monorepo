import { ArtifactDeployed, ArtifactNew, ArtifactReader, ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { DeployedIsmAddress, DeployedRawIsmArtifact, IRawIsmArtifactManager, IsmType, RawIsmArtifactConfigs, TestIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { TronProvider } from '../clients/provider.js';
import { TronSigner } from '../clients/signer.js';
import { TronSDKTransaction } from '../utils/types.js';
type AnnotatedTronTransaction = TronSDKTransaction;
/**
 * TronIsmArtifactManager implements ISM deployment for Tron.
 * Since Tron is EVM-compatible, we use the same Solidity contract bytecode.
 */
export declare class TronIsmArtifactManager implements IRawIsmArtifactManager {
    private readonly provider;
    constructor(provider: TronProvider);
    readIsm(address: string): Promise<DeployedRawIsmArtifact>;
    createReader<T extends IsmType>(type: T): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress>;
    createWriter<T extends IsmType>(type: T, signer: TronSigner): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress>;
}
export declare class TronTestIsmReader implements ArtifactReader<TestIsmConfig, DeployedIsmAddress> {
    protected readonly provider: TronProvider;
    constructor(provider: TronProvider);
    read(address: string): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>>;
}
export declare class TronTestIsmWriter extends TronTestIsmReader implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress> {
    private readonly signer;
    constructor(provider: TronProvider, signer: TronSigner);
    create(artifact: ArtifactNew<TestIsmConfig>): Promise<[
        ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>,
        TxReceipt[]
    ]>;
    update(_artifact: ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>): Promise<AnnotatedTronTransaction[]>;
}
export {};
//# sourceMappingURL=ism-artifact-manager.d.ts.map