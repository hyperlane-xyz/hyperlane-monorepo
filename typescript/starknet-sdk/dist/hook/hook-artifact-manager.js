import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState, } from '@hyperlane-xyz/provider-sdk/artifact';
import { eqAddressStarknet, assert } from '@hyperlane-xyz/utils';
import { StarknetProvider } from '../clients/provider.js';
import { StarknetContractName, callContract, getFeeTokenAddress, getStarknetContract, normalizeStarknetAddressSafe, populateInvokeTx, } from '../contracts.js';
class StarknetMerkleTreeHookReader {
    async read(address) {
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: { type: AltVM.HookType.MERKLE_TREE },
            deployed: { address: normalizeStarknetAddressSafe(address) },
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
class StarknetProtocolFeeAsIgpHookReader {
    chainMetadata;
    constructor(chainMetadata) {
        this.chainMetadata = chainMetadata;
    }
    async read(address) {
        const normalizedAddress = normalizeStarknetAddressSafe(address);
        const hook = getStarknetContract(StarknetContractName.PROTOCOL_FEE, normalizedAddress);
        const [owner, beneficiary] = await Promise.all([
            callContract(hook, 'owner'),
            callContract(hook, 'get_beneficiary'),
        ]);
        const ownerAddress = normalizeStarknetAddressSafe(owner);
        const beneficiaryAddress = normalizeStarknetAddressSafe(beneficiary);
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                type: AltVM.HookType.INTERCHAIN_GAS_PAYMASTER,
                owner: ownerAddress,
                beneficiary: beneficiaryAddress,
                oracleKey: ownerAddress,
                overhead: {},
                oracleConfig: {},
            },
            deployed: { address: normalizedAddress },
        };
    }
}
class StarknetProtocolFeeAsIgpHookWriter extends StarknetProtocolFeeAsIgpHookReader {
    signer;
    constructor(chainMetadata, signer) {
        super(chainMetadata);
        this.signer = signer;
    }
    assertSupportedIgpShape(config) {
        assert(Object.keys(config.overhead).length === 0, 'Starknet protocol_fee hook does not support overhead gas config updates');
        assert(Object.keys(config.oracleConfig).length === 0, 'Starknet protocol_fee hook does not support oracle gas config updates');
        assert(eqAddressStarknet(config.oracleKey, config.owner), 'Starknet protocol_fee mapping requires oracleKey to equal owner');
    }
    async create(artifact) {
        this.assertSupportedIgpShape(artifact.config);
        const tokenAddress = getFeeTokenAddress({
            chainName: this.chainMetadata.name,
            nativeDenom: this.chainMetadata.nativeToken?.denom,
        });
        const deployTx = {
            kind: 'deploy',
            contractName: StarknetContractName.PROTOCOL_FEE,
            constructorArgs: [
                0,
                0,
                normalizeStarknetAddressSafe(artifact.config.beneficiary),
                normalizeStarknetAddressSafe(artifact.config.owner),
                tokenAddress,
            ],
        };
        const receipt = await this.signer.sendAndConfirmTransaction(deployTx);
        assert(receipt.contractAddress, 'failed to deploy Starknet protocol_fee hook');
        return [
            {
                artifactState: ArtifactState.DEPLOYED,
                config: artifact.config,
                deployed: { address: normalizeStarknetAddressSafe(receipt.contractAddress) },
            },
            [receipt],
        ];
    }
    async update(artifact) {
        this.assertSupportedIgpShape(artifact.config);
        const current = await this.read(artifact.deployed.address);
        const contractAddress = artifact.deployed.address;
        const contract = getStarknetContract(StarknetContractName.PROTOCOL_FEE, contractAddress);
        const txs = [];
        if (!eqAddressStarknet(current.config.beneficiary, artifact.config.beneficiary)) {
            txs.push({
                annotation: `Updating protocol fee beneficiary for ${contractAddress}`,
                ...(await populateInvokeTx(contract, 'set_beneficiary', [
                    normalizeStarknetAddressSafe(artifact.config.beneficiary),
                ])),
            });
        }
        if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
            txs.push({
                annotation: `Transferring protocol fee hook ownership for ${contractAddress}`,
                ...(await populateInvokeTx(contract, 'transfer_ownership', [
                    normalizeStarknetAddressSafe(artifact.config.owner),
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
        this.provider = StarknetProvider.connect((chainMetadata.rpcUrls ?? []).map(({ http }) => http), chainMetadata.chainId, { metadata: chainMetadata });
        this.mailboxAddress = context?.mailbox
            ? normalizeStarknetAddressSafe(context.mailbox)
            : '';
    }
    async readHook(address) {
        const hookType = await this.provider.getHookType({ hookAddress: address });
        if (hookType === AltVM.HookType.MERKLE_TREE) {
            return this.createReader(AltVM.HookType.MERKLE_TREE).read(address);
        }
        if (hookType === AltVM.HookType.PROTOCOL_FEE ||
            hookType === AltVM.HookType.INTERCHAIN_GAS_PAYMASTER) {
            return this.createReader(AltVM.HookType.INTERCHAIN_GAS_PAYMASTER).read(address);
        }
        throw new Error(`Unsupported Starknet hook type: ${hookType}`);
    }
    createReader(type) {
        const readers = {
            merkleTreeHook: () => new StarknetMerkleTreeHookReader(),
            interchainGasPaymaster: () => new StarknetProtocolFeeAsIgpHookReader(this.chainMetadata),
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
            merkleTreeHook: () => {
                assert(this.mailboxAddress, 'mailbox address required for Starknet merkle tree hook deployment');
                return new StarknetMerkleTreeHookWriter(starknetSigner, this.mailboxAddress);
            },
            interchainGasPaymaster: () => new StarknetProtocolFeeAsIgpHookWriter(this.chainMetadata, starknetSigner),
        };
        const writerFactory = writers[type];
        if (!writerFactory) {
            throw new Error(`Unsupported Starknet hook type: ${type}`);
        }
        return writerFactory();
    }
}
//# sourceMappingURL=hook-artifact-manager.js.map