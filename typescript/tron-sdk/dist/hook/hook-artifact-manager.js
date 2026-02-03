import { InterchainGasPaymaster__factory, MerkleTreeHook__factory, } from '@hyperlane-xyz/core';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState, } from '@hyperlane-xyz/provider-sdk/artifact';
import { strip0x } from '@hyperlane-xyz/utils';
/**
 * Maps AltVM HookType enum values to provider-sdk HookType string literals.
 */
function altVmHookTypeToProviderSdkType(altVmType) {
    switch (altVmType) {
        case AltVM.HookType.MERKLE_TREE:
            return 'merkleTreeHook';
        case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
            return 'interchainGasPaymaster';
        default:
            throw new Error(`Unsupported Hook type: ${altVmType}`);
    }
}
/**
 * TronHookArtifactManager implements Hook deployment for Tron.
 * Since Tron is EVM-compatible, we use the same Solidity contract bytecode.
 */
export class TronHookArtifactManager {
    provider;
    mailboxAddress;
    constructor(provider, mailboxAddress) {
        this.provider = provider;
        this.mailboxAddress = mailboxAddress;
    }
    async readHook(address) {
        const altVmHookType = await this.provider.getHookType({
            hookAddress: address,
        });
        const hookType = altVmHookTypeToProviderSdkType(altVmHookType);
        const reader = this.createReader(hookType);
        return reader.read(address);
    }
    createReader(type) {
        switch (type) {
            case AltVM.HookType.MERKLE_TREE:
                return new TronMerkleTreeHookReader(this.provider);
            case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
                return new TronIgpHookReader(this.provider);
            default:
                throw new Error(`Hook type ${type} reader not yet implemented for Tron`);
        }
    }
    createWriter(type, signer) {
        switch (type) {
            case AltVM.HookType.MERKLE_TREE:
                return new TronMerkleTreeHookWriter(this.provider, signer, this.mailboxAddress);
            case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
                return new TronIgpHookWriter(this.provider, signer);
            default:
                throw new Error(`Hook type ${type} writer not yet implemented for Tron`);
        }
    }
}
// ============ Merkle Tree Hook ============
export class TronMerkleTreeHookReader {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async read(address) {
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: { type: AltVM.HookType.MERKLE_TREE },
            deployed: { address },
        };
    }
}
export class TronMerkleTreeHookWriter extends TronMerkleTreeHookReader {
    signer;
    mailboxAddress;
    constructor(provider, signer, mailboxAddress) {
        super(provider);
        this.signer = signer;
        this.mailboxAddress = mailboxAddress;
    }
    async create(artifact) {
        const { abi, bytecode } = MerkleTreeHook__factory;
        // MerkleTreeHook constructor takes (address _mailbox)
        const result = await this.signer.deployContractWithArtifacts({
            abi: abi,
            bytecode: strip0x(bytecode),
            constructorParams: [this.mailboxAddress],
            name: 'MerkleTreeHook',
        });
        const deployedArtifact = {
            artifactState: ArtifactState.DEPLOYED,
            config: artifact.config,
            deployed: { address: result.address },
        };
        const receipt = {
            txId: result.txId,
            blockNumber: 0,
            success: true,
            contractAddress: result.address,
        };
        return [deployedArtifact, [receipt]];
    }
    async update(_artifact) {
        // MerkleTreeHook has no mutable state
        return [];
    }
}
// ============ Interchain Gas Paymaster Hook ============
export class TronIgpHookReader {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async read(address) {
        // Read IGP config from chain
        const igpData = await this.provider.getInterchainGasPaymasterHook({
            hookAddress: address,
        });
        // Convert destinationGasConfigs to overhead and oracleConfig format
        const overhead = {};
        const oracleConfig = {};
        for (const [domainIdStr, config] of Object.entries(igpData.destinationGasConfigs)) {
            const domainId = parseInt(domainIdStr);
            overhead[domainId] = parseInt(config.gasOverhead);
            oracleConfig[domainId] = {
                gasPrice: config.gasOracle.gasPrice,
                tokenExchangeRate: config.gasOracle.tokenExchangeRate,
            };
        }
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
                owner: igpData.owner,
                beneficiary: igpData.owner, // Default to owner
                oracleKey: igpData.owner, // Default to owner
                overhead,
                oracleConfig,
            },
            deployed: { address },
        };
    }
}
export class TronIgpHookWriter extends TronIgpHookReader {
    signer;
    constructor(provider, signer) {
        super(provider);
        this.signer = signer;
    }
    async create(artifact) {
        const { abi, bytecode } = InterchainGasPaymaster__factory;
        // InterchainGasPaymaster constructor takes no arguments
        // It uses OpenZeppelin's Ownable which sets msg.sender as owner
        const result = await this.signer.deployContractWithArtifacts({
            abi: abi,
            bytecode: strip0x(bytecode),
            constructorParams: [],
            name: 'InterchainGasPaymaster',
        });
        const deployedArtifact = {
            artifactState: ArtifactState.DEPLOYED,
            config: artifact.config,
            deployed: { address: result.address },
        };
        const receipt = {
            txId: result.txId,
            blockNumber: 0,
            success: true,
            contractAddress: result.address,
        };
        return [deployedArtifact, [receipt]];
    }
    async update(_artifact) {
        // TODO: Implement IGP configuration updates (gas configs, owner transfer, etc.)
        return [];
    }
}
//# sourceMappingURL=hook-artifact-manager.js.map