import { ArtifactState, } from '@hyperlane-xyz/provider-sdk/artifact';
import { ZERO_ADDRESS_HEX_32, eqAddressStarknet, assert } from '@hyperlane-xyz/utils';
import { StarknetProvider } from '../clients/provider.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
class StarknetMailboxReader {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async read(address) {
        const mailbox = await this.provider.getMailbox({ mailboxAddress: address });
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                owner: mailbox.owner,
                defaultIsm: {
                    artifactState: ArtifactState.UNDERIVED,
                    deployed: { address: normalizeStarknetAddressSafe(mailbox.defaultIsm) },
                },
                defaultHook: {
                    artifactState: ArtifactState.UNDERIVED,
                    deployed: { address: normalizeStarknetAddressSafe(mailbox.defaultHook) },
                },
                requiredHook: {
                    artifactState: ArtifactState.UNDERIVED,
                    deployed: { address: normalizeStarknetAddressSafe(mailbox.requiredHook) },
                },
            },
            deployed: {
                address: normalizeStarknetAddressSafe(mailbox.address),
                domainId: mailbox.localDomain,
            },
        };
    }
}
class StarknetMailboxWriter extends StarknetMailboxReader {
    signer;
    chainMetadata;
    constructor(provider, signer, chainMetadata) {
        super(provider);
        this.signer = signer;
        this.chainMetadata = chainMetadata;
    }
    getNestedAddress(nested) {
        return normalizeStarknetAddressSafe(nested.deployed.address);
    }
    async create(artifact) {
        const defaultIsmAddress = this.getNestedAddress(artifact.config.defaultIsm);
        const defaultHookAddress = this.getNestedAddress(artifact.config.defaultHook);
        const requiredHookAddress = this.getNestedAddress(artifact.config.requiredHook);
        const receipts = [];
        const createTx = await this.signer.getCreateMailboxTransaction({
            signer: this.signer.getSignerAddress(),
            domainId: this.chainMetadata.domainId,
            defaultIsmAddress,
            proxyAdminAddress: undefined,
        });
        const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
        receipts.push(createReceipt);
        assert(createReceipt.contractAddress, 'failed to deploy Starknet mailbox');
        const mailboxAddress = createReceipt.contractAddress;
        if (!eqAddressStarknet(defaultHookAddress, ZERO_ADDRESS_HEX_32)) {
            const tx = await this.signer.getSetDefaultHookTransaction({
                signer: this.signer.getSignerAddress(),
                mailboxAddress,
                hookAddress: defaultHookAddress,
            });
            receipts.push(await this.signer.sendAndConfirmTransaction(tx));
        }
        if (!eqAddressStarknet(requiredHookAddress, ZERO_ADDRESS_HEX_32)) {
            const tx = await this.signer.getSetRequiredHookTransaction({
                signer: this.signer.getSignerAddress(),
                mailboxAddress,
                hookAddress: requiredHookAddress,
            });
            receipts.push(await this.signer.sendAndConfirmTransaction(tx));
        }
        if (!eqAddressStarknet(artifact.config.owner, this.signer.getSignerAddress())) {
            const tx = await this.signer.getSetMailboxOwnerTransaction({
                signer: this.signer.getSignerAddress(),
                mailboxAddress,
                newOwner: artifact.config.owner,
            });
            receipts.push(await this.signer.sendAndConfirmTransaction(tx));
        }
        const deployed = await this.read(mailboxAddress);
        return [deployed, receipts];
    }
    async update(artifact) {
        const current = await this.read(artifact.deployed.address);
        const mailboxAddress = artifact.deployed.address;
        const updateTxs = [];
        const expectedDefaultIsm = this.getNestedAddress(artifact.config.defaultIsm);
        const expectedDefaultHook = this.getNestedAddress(artifact.config.defaultHook);
        const expectedRequiredHook = this.getNestedAddress(artifact.config.requiredHook);
        const currentDefaultIsm = this.getNestedAddress(current.config.defaultIsm);
        const currentDefaultHook = this.getNestedAddress(current.config.defaultHook);
        const currentRequiredHook = this.getNestedAddress(current.config.requiredHook);
        if (!eqAddressStarknet(currentDefaultIsm, expectedDefaultIsm)) {
            updateTxs.push({
                annotation: `Setting mailbox default ISM`,
                ...(await this.signer.getSetDefaultIsmTransaction({
                    signer: this.signer.getSignerAddress(),
                    mailboxAddress,
                    ismAddress: expectedDefaultIsm,
                })),
            });
        }
        if (!eqAddressStarknet(currentDefaultHook, expectedDefaultHook)) {
            updateTxs.push({
                annotation: `Setting mailbox default hook`,
                ...(await this.signer.getSetDefaultHookTransaction({
                    signer: this.signer.getSignerAddress(),
                    mailboxAddress,
                    hookAddress: expectedDefaultHook,
                })),
            });
        }
        if (!eqAddressStarknet(currentRequiredHook, expectedRequiredHook)) {
            updateTxs.push({
                annotation: `Setting mailbox required hook`,
                ...(await this.signer.getSetRequiredHookTransaction({
                    signer: this.signer.getSignerAddress(),
                    mailboxAddress,
                    hookAddress: expectedRequiredHook,
                })),
            });
        }
        if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
            updateTxs.push({
                annotation: `Setting mailbox owner`,
                ...(await this.signer.getSetMailboxOwnerTransaction({
                    signer: this.signer.getSignerAddress(),
                    mailboxAddress,
                    newOwner: artifact.config.owner,
                })),
            });
        }
        return updateTxs;
    }
}
export class StarknetMailboxArtifactManager {
    chainMetadata;
    provider;
    constructor(chainMetadata) {
        this.chainMetadata = chainMetadata;
        this.provider = StarknetProvider.connect((chainMetadata.rpcUrls ?? []).map(({ http }) => http), chainMetadata.chainId, { metadata: chainMetadata });
    }
    readMailbox(address) {
        return this.createReader('mailbox').read(address);
    }
    createReader(type) {
        if (type !== 'mailbox') {
            throw new Error(`Unsupported Starknet mailbox type: ${type}`);
        }
        return new StarknetMailboxReader(this.provider);
    }
    createWriter(type, signer) {
        if (type !== 'mailbox') {
            throw new Error(`Unsupported Starknet mailbox type: ${type}`);
        }
        return new StarknetMailboxWriter(this.provider, signer, this.chainMetadata);
    }
}
//# sourceMappingURL=mailbox-artifact-manager.js.map