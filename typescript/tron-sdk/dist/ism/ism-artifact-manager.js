import { TrustedRelayerIsm__factory } from '@hyperlane-xyz/core';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState, } from '@hyperlane-xyz/provider-sdk/artifact';
import { strip0x } from '@hyperlane-xyz/utils';
/**
 * Maps AltVM IsmType enum values to provider-sdk IsmType string literals.
 */
function altVmIsmTypeToProviderSdkType(altVmType) {
    switch (altVmType) {
        case AltVM.IsmType.TEST_ISM:
            return 'testIsm';
        case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
            return 'merkleRootMultisigIsm';
        case AltVM.IsmType.MESSAGE_ID_MULTISIG:
            return 'messageIdMultisigIsm';
        case AltVM.IsmType.ROUTING:
            return 'domainRoutingIsm';
        default:
            throw new Error(`Unsupported ISM type: ${altVmType}`);
    }
}
/**
 * TronIsmArtifactManager implements ISM deployment for Tron.
 * Since Tron is EVM-compatible, we use the same Solidity contract bytecode.
 *
 * For multisig ISMs, factory addresses must be provided. These factories
 * are deployed as part of core deployment.
 */
export class TronIsmArtifactManager {
    provider;
    factories;
    constructor(provider, factories) {
        this.provider = provider;
        this.factories = factories;
    }
    async readIsm(address) {
        const altVmIsmType = await this.provider.getIsmType({
            ismAddress: address,
        });
        const ismType = altVmIsmTypeToProviderSdkType(altVmIsmType);
        const reader = this.createReader(ismType);
        return reader.read(address);
    }
    createReader(type) {
        switch (type) {
            case AltVM.IsmType.TEST_ISM:
                return new TronTestIsmReader(this.provider);
            case AltVM.IsmType.MESSAGE_ID_MULTISIG:
                return new TronMultisigIsmReader(this.provider, AltVM.IsmType.MESSAGE_ID_MULTISIG);
            case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
                return new TronMultisigIsmReader(this.provider, AltVM.IsmType.MERKLE_ROOT_MULTISIG);
            default:
                throw new Error(`ISM type ${type} reader not yet implemented for Tron`);
        }
    }
    createWriter(type, signer) {
        switch (type) {
            case AltVM.IsmType.TEST_ISM:
                return new TronTestIsmWriter(this.provider, signer);
            case AltVM.IsmType.MESSAGE_ID_MULTISIG:
                if (!this.factories?.staticMessageIdMultisigIsmFactory) {
                    throw new Error('staticMessageIdMultisigIsmFactory address required for MESSAGE_ID_MULTISIG');
                }
                return new TronMultisigIsmWriter(this.provider, signer, this.factories.staticMessageIdMultisigIsmFactory, AltVM.IsmType.MESSAGE_ID_MULTISIG);
            case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
                if (!this.factories?.staticMerkleRootMultisigIsmFactory) {
                    throw new Error('staticMerkleRootMultisigIsmFactory address required for MERKLE_ROOT_MULTISIG');
                }
                return new TronMultisigIsmWriter(this.provider, signer, this.factories.staticMerkleRootMultisigIsmFactory, AltVM.IsmType.MERKLE_ROOT_MULTISIG);
            default:
                throw new Error(`ISM type ${type} writer not yet implemented for Tron`);
        }
    }
}
// ============ Test ISM (TrustedRelayerIsm) ============
export class TronTestIsmReader {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async read(address) {
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: { type: AltVM.IsmType.TEST_ISM },
            deployed: { address },
        };
    }
}
export class TronTestIsmWriter extends TronTestIsmReader {
    signer;
    constructor(provider, signer) {
        super(provider);
        this.signer = signer;
    }
    async create(artifact) {
        // Deploy TrustedRelayerIsm with the signer as the trusted relayer
        const { abi, bytecode } = TrustedRelayerIsm__factory;
        const signerAddress = this.signer.getSignerAddress();
        // TrustedRelayerIsm constructor takes (address _mailbox)
        // For testing, we use a placeholder - actual deployment should use real mailbox
        const result = await this.signer.deployContractWithArtifacts({
            abi: abi,
            bytecode: strip0x(bytecode),
            constructorParams: [signerAddress], // Use signer as placeholder mailbox
            name: 'TrustedRelayerIsm',
        });
        const deployedArtifact = {
            artifactState: ArtifactState.DEPLOYED,
            config: artifact.config,
            deployed: { address: result.address },
        };
        // Create a TxReceipt from TronSDKReceipt
        const receipt = {
            txId: result.txId,
            blockNumber: 0, // Will be filled after confirmation
            success: true,
            contractAddress: result.address,
        };
        return [deployedArtifact, [receipt]];
    }
    async update(_artifact) {
        // Test ISM has no mutable state
        return [];
    }
}
// ============ Multisig ISM ============
export class TronMultisigIsmReader {
    provider;
    ismType;
    constructor(provider, ismType) {
        this.provider = provider;
        this.ismType = ismType;
    }
    async read(address) {
        // Read validators and threshold from the ISM contract
        const ismData = this.ismType === AltVM.IsmType.MESSAGE_ID_MULTISIG
            ? await this.provider.getMessageIdMultisigIsm({ ismAddress: address })
            : await this.provider.getMerkleRootMultisigIsm({ ismAddress: address });
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                type: this.ismType,
                validators: ismData.validators,
                threshold: ismData.threshold,
            },
            deployed: { address },
        };
    }
}
export class TronMultisigIsmWriter extends TronMultisigIsmReader {
    signer;
    factoryAddress;
    constructor(provider, signer, factoryAddress, ismType) {
        super(provider, ismType);
        this.signer = signer;
        this.factoryAddress = factoryAddress;
    }
    async create(artifact) {
        const { validators, threshold } = artifact.config;
        // Sort validators for deterministic address generation
        const sortedValidators = [...validators].sort();
        // Call factory.deploy(validators, threshold) to create new ISM
        // The factory uses CREATE2 for deterministic addresses
        const receipt = await this.signer.callContract(this.factoryAddress, 'deploy(address[],uint8)', [
            { type: 'address[]', value: sortedValidators },
            { type: 'uint8', value: threshold },
        ]);
        // Get the deployed ISM address from the factory
        // The address is deterministic based on validators and threshold
        const ismAddress = await this.getDeployedAddress(sortedValidators, threshold);
        const deployedArtifact = {
            artifactState: ArtifactState.DEPLOYED,
            config: artifact.config,
            deployed: { address: ismAddress },
        };
        return [deployedArtifact, [receipt]];
    }
    /**
     * Get the deterministic address for an ISM with given validators and threshold.
     * Uses the factory's getAddress function.
     */
    async getDeployedAddress(validators, threshold) {
        const result = await this.provider.callContractView(this.factoryAddress, 'getAddress(address[],uint8)', [
            { type: 'address[]', value: validators },
            { type: 'uint8', value: threshold },
        ]);
        return result;
    }
    async update(_artifact) {
        // Static multisig ISMs are immutable
        return [];
    }
}
//# sourceMappingURL=ism-artifact-manager.js.map