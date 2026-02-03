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
 */
export class TronIsmArtifactManager {
    provider;
    constructor(provider) {
        this.provider = provider;
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
            default:
                throw new Error(`ISM type ${type} reader not yet implemented for Tron`);
        }
    }
    createWriter(type, signer) {
        switch (type) {
            case AltVM.IsmType.TEST_ISM:
                return new TronTestIsmWriter(this.provider, signer);
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
//# sourceMappingURL=ism-artifact-manager.js.map