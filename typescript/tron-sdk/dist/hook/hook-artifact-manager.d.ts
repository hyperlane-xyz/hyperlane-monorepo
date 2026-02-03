import { ArtifactDeployed, ArtifactNew, ArtifactReader, ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { DeployedHookAddress, DeployedHookArtifact, HookType, IRawHookArtifactManager, IgpHookConfig, MerkleTreeHookConfig, RawHookArtifactConfigs } from '@hyperlane-xyz/provider-sdk/hook';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { TronProvider } from '../clients/provider.js';
import { TronSigner } from '../clients/signer.js';
import { TronSDKTransaction } from '../utils/types.js';
type AnnotatedTronTransaction = TronSDKTransaction;
/**
 * TronHookArtifactManager implements Hook deployment for Tron.
 * Since Tron is EVM-compatible, we use the same Solidity contract bytecode.
 */
export declare class TronHookArtifactManager implements IRawHookArtifactManager {
    private readonly provider;
    private readonly mailboxAddress;
    constructor(provider: TronProvider, mailboxAddress: string);
    readHook(address: string): Promise<DeployedHookArtifact>;
    createReader<T extends HookType>(type: T): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress>;
    createWriter<T extends HookType>(type: T, signer: TronSigner): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress>;
}
export declare class TronMerkleTreeHookReader implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddress> {
    protected readonly provider: TronProvider;
    constructor(provider: TronProvider);
    read(address: string): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>>;
}
export declare class TronMerkleTreeHookWriter extends TronMerkleTreeHookReader implements ArtifactWriter<MerkleTreeHookConfig, DeployedHookAddress> {
    private readonly signer;
    private readonly mailboxAddress;
    constructor(provider: TronProvider, signer: TronSigner, mailboxAddress: string);
    create(artifact: ArtifactNew<MerkleTreeHookConfig>): Promise<[
        ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
        TxReceipt[]
    ]>;
    update(_artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>): Promise<AnnotatedTronTransaction[]>;
}
export declare class TronIgpHookReader implements ArtifactReader<IgpHookConfig, DeployedHookAddress> {
    protected readonly provider: TronProvider;
    constructor(provider: TronProvider);
    read(address: string): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>>;
}
export declare class TronIgpHookWriter extends TronIgpHookReader implements ArtifactWriter<IgpHookConfig, DeployedHookAddress> {
    private readonly signer;
    constructor(provider: TronProvider, signer: TronSigner);
    create(artifact: ArtifactNew<IgpHookConfig>): Promise<[
        ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
        TxReceipt[]
    ]>;
    update(_artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>): Promise<AnnotatedTronTransaction[]>;
}
export {};
//# sourceMappingURL=hook-artifact-manager.d.ts.map