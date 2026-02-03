import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactDeployed, ArtifactNew, ArtifactReader, ArtifactWriter } from '@hyperlane-xyz/provider-sdk/artifact';
import { DeployedIsmAddress, DeployedRawIsmArtifact, IRawIsmArtifactManager, IsmType, MultisigIsmConfig, RawIsmArtifactConfigs, TestIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { TronProvider } from '../clients/provider.js';
import { TronSigner } from '../clients/signer.js';
import { TronSDKTransaction } from '../utils/types.js';
type AnnotatedTronTransaction = TronSDKTransaction;
/**
 * Factory addresses for ISM deployment on Tron.
 * These are deployed as part of core deployment.
 */
export interface TronIsmFactories {
    staticMessageIdMultisigIsmFactory?: string;
    staticMerkleRootMultisigIsmFactory?: string;
}
/**
 * TronIsmArtifactManager implements ISM deployment for Tron.
 * Since Tron is EVM-compatible, we use the same Solidity contract bytecode.
 *
 * For multisig ISMs, factory addresses must be provided. These factories
 * are deployed as part of core deployment.
 */
export declare class TronIsmArtifactManager implements IRawIsmArtifactManager {
    private readonly provider;
    private readonly factories?;
    constructor(provider: TronProvider, factories?: TronIsmFactories | undefined);
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
export declare class TronMultisigIsmReader implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress> {
    protected readonly provider: TronProvider;
    protected readonly ismType: typeof AltVM.IsmType.MESSAGE_ID_MULTISIG | typeof AltVM.IsmType.MERKLE_ROOT_MULTISIG;
    constructor(provider: TronProvider, ismType: typeof AltVM.IsmType.MESSAGE_ID_MULTISIG | typeof AltVM.IsmType.MERKLE_ROOT_MULTISIG);
    read(address: string): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>>;
}
export declare class TronMultisigIsmWriter extends TronMultisigIsmReader implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress> {
    private readonly signer;
    private readonly factoryAddress;
    constructor(provider: TronProvider, signer: TronSigner, factoryAddress: string, ismType: typeof AltVM.IsmType.MESSAGE_ID_MULTISIG | typeof AltVM.IsmType.MERKLE_ROOT_MULTISIG);
    create(artifact: ArtifactNew<MultisigIsmConfig>): Promise<[
        ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
        TxReceipt[]
    ]>;
    /**
     * Get the deterministic address for an ISM with given validators and threshold.
     * Uses the factory's getAddress function.
     */
    private getDeployedAddress;
    update(_artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>): Promise<AnnotatedTronTransaction[]>;
}
export {};
//# sourceMappingURL=ism-artifact-manager.d.ts.map