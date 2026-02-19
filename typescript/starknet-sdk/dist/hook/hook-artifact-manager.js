import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState, } from '@hyperlane-xyz/provider-sdk/artifact';
import { eqAddressStarknet } from '@hyperlane-xyz/utils';
import { StarknetProvider } from '../clients/provider.js';
import { StarknetContractName, callContract, getFeeTokenAddress, getStarknetContract, normalizeStarknetAddress, populateInvokeTx, toBigInt, } from '../contracts.js';
class StarknetMerkleTreeHookReader {
    async read(address) {
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                type: AltVM.HookType.MERKLE_TREE,
            },
            deployed: {
                address: normalizeStarknetAddress(address),
            },
        };
    }
}
class StarknetMerkleTreeHookWriter extends StarknetMerkleTreeHookReader {
    signer;
    mailboxAddress;
    constructor(signer, mailboxAddress) {
        super();
        this.signer = signer;
        this.mailboxAddress = mailboxAddress;
    }
    async create(artifact) {
        const deployed = await this.signer.createMerkleTreeHook({
            mailboxAddress: this.mailboxAddress,
        });
        return [
            {
                artifactState: ArtifactState.DEPLOYED,
                config: artifact.config,
                deployed: { address: deployed.hookAddress },
            },
            [],
        ];
    }
    async update(_artifact) {
        return [];
    }
}
class StarknetProtocolFeeHookReader {
    chainMetadata;
    constructor(chainMetadata) {
        this.chainMetadata = chainMetadata;
    }
    async read(address) {
        const normalizedAddress = normalizeStarknetAddress(address);
        const hook = getStarknetContract(StarknetContractName.PROTOCOL_FEE, normalizedAddress);
        const [owner, beneficiary, protocolFee, maxProtocolFee] = await Promise.all([
            callContract(hook, 'owner'),
            callContract(hook, 'get_beneficiary'),
            callContract(hook, 'get_protocol_fee'),
            callContract(hook, 'get_max_protocol_fee').catch(() => 0),
        ]);
        const tokenAddress = getFeeTokenAddress({
            chainName: this.chainMetadata.name,
            nativeDenom: this.chainMetadata.nativeToken?.denom,
        });
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                type: AltVM.HookType.PROTOCOL_FEE,
                owner: normalizeStarknetAddress(owner),
                beneficiary: normalizeStarknetAddress(beneficiary),
                protocolFee: toBigInt(protocolFee).toString(),
                maxProtocolFee: toBigInt(maxProtocolFee).toString(),
                tokenAddress,
            },
            deployed: {
                address: normalizedAddress,
            },
        };
    }
}
class StarknetProtocolFeeHookWriter extends StarknetProtocolFeeHookReader {
    signer;
    constructor(chainMetadata, signer) {
        super(chainMetadata);
        this.signer = signer;
    }
    async create(artifact) {
        const deployTx = {
            kind: 'deploy',
            contractName: StarknetContractName.PROTOCOL_FEE,
            constructorArgs: [
                artifact.config.maxProtocolFee,
                artifact.config.protocolFee,
                normalizeStarknetAddress(artifact.config.beneficiary),
                normalizeStarknetAddress(artifact.config.owner),
                normalizeStarknetAddress(artifact.config.tokenAddress),
            ],
        };
        const receipt = await this.signer.sendAndConfirmTransaction(deployTx);
        return [
            {
                artifactState: ArtifactState.DEPLOYED,
                config: artifact.config,
                deployed: {
                    address: normalizeStarknetAddress(receipt.contractAddress),
                },
            },
            [receipt],
        ];
    }
    async update(artifact) {
        const current = await this.read(artifact.deployed.address);
        const contractAddress = artifact.deployed.address;
        const contract = getStarknetContract(StarknetContractName.PROTOCOL_FEE, contractAddress);
        const txs = [];
        if (current.config.protocolFee !== artifact.config.protocolFee) {
            txs.push({
                annotation: `Updating protocol fee for ${contractAddress}`,
                ...(await populateInvokeTx(contract, 'set_protocol_fee', [
                    artifact.config.protocolFee,
                ])),
            });
        }
        if (!eqAddressStarknet(current.config.beneficiary, artifact.config.beneficiary)) {
            txs.push({
                annotation: `Updating protocol fee beneficiary for ${contractAddress}`,
                ...(await populateInvokeTx(contract, 'set_beneficiary', [
                    normalizeStarknetAddress(artifact.config.beneficiary),
                ])),
            });
        }
        if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
            txs.push({
                annotation: `Transferring protocol fee hook ownership for ${contractAddress}`,
                ...(await populateInvokeTx(contract, 'transfer_ownership', [
                    normalizeStarknetAddress(artifact.config.owner),
                ])),
            });
        }
        return txs;
    }
}
export class StarknetHookArtifactManager {
    chainMetadata;
    provider;
    mailboxAddress;
    constructor(chainMetadata, context) {
        this.chainMetadata = chainMetadata;
        this.provider = StarknetProvider.connect((chainMetadata.rpcUrls ?? []).map((rpc) => rpc.http), chainMetadata.chainId, { metadata: chainMetadata });
        this.mailboxAddress = context?.mailbox
            ? normalizeStarknetAddress(context.mailbox)
            : '';
    }
    async readHook(address) {
        const type = await this.provider.getHookType({ hookAddress: address });
        const reader = this.createReader(type);
        return reader.read(address);
    }
    createReader(type) {
        const readers = {
            merkleTreeHook: () => new StarknetMerkleTreeHookReader(),
            protocolFee: () => new StarknetProtocolFeeHookReader(this.chainMetadata),
            interchainGasPaymaster: () => {
                throw new Error('IGP hook is unsupported on Starknet');
            },
        };
        const readerFactory = readers[type];
        if (!readerFactory) {
            throw new Error(`Unsupported Starknet hook type: ${type}`);
        }
        return readerFactory();
    }
    createWriter(type, signer) {
        const starknetSigner = signer;
        const writers = {
            merkleTreeHook: () => new StarknetMerkleTreeHookWriter(starknetSigner, this.mailboxAddress),
            protocolFee: () => new StarknetProtocolFeeHookWriter(this.chainMetadata, starknetSigner),
            interchainGasPaymaster: () => {
                throw new Error('IGP hook is unsupported on Starknet');
            },
        };
        const writerFactory = writers[type];
        if (!writerFactory) {
            throw new Error(`Unsupported Starknet hook type: ${type}`);
        }
        return writerFactory();
    }
}
//# sourceMappingURL=hook-artifact-manager.js.map