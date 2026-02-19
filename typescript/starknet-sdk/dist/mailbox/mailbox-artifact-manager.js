import { ArtifactState, } from '@hyperlane-xyz/provider-sdk/artifact';
import { ZERO_ADDRESS_HEX_32, eqAddressStarknet } from '@hyperlane-xyz/utils';
import { StarknetProvider } from '../clients/provider.js';
import { normalizeStarknetAddress } from '../contracts.js';
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
                    deployed: {
                        address: mailbox.defaultIsm || ZERO_ADDRESS_HEX_32,
                    },
                },
                defaultHook: {
                    artifactState: ArtifactState.UNDERIVED,
                    deployed: {
                        address: mailbox.defaultHook || ZERO_ADDRESS_HEX_32,
                    },
                },
                requiredHook: {
                    artifactState: ArtifactState.UNDERIVED,
                    deployed: {
                        address: mailbox.requiredHook || ZERO_ADDRESS_HEX_32,
                    },
                },
            },
            deployed: {
                address: mailbox.address,
                domainId: mailbox.localDomain,
            },
        };
    }
}
class StarknetMailboxWriter extends StarknetMailboxReader {
    signer;
    domainId;
    constructor(provider, signer, domainId) {
        super(provider);
        this.signer = signer;
        this.domainId = domainId;
    }
    async create(artifact) {
        const created = await this.signer.createMailbox({
            domainId: this.domainId,
            defaultIsmAddress: artifact.config.defaultIsm.deployed.address,
        });
        await this.signer.setDefaultHook({
            mailboxAddress: created.mailboxAddress,
            hookAddress: artifact.config.defaultHook.deployed.address,
        });
        await this.signer.setRequiredHook({
            mailboxAddress: created.mailboxAddress,
            hookAddress: artifact.config.requiredHook.deployed.address,
        });
        if (!eqAddressStarknet(artifact.config.owner, this.signer.getSignerAddress())) {
            await this.signer.setMailboxOwner({
                mailboxAddress: created.mailboxAddress,
                newOwner: artifact.config.owner,
            });
        }
        const deployedArtifact = await this.read(created.mailboxAddress);
        return [deployedArtifact, []];
    }
    async update(artifact) {
        const current = await this.read(artifact.deployed.address);
        const txs = [];
        if (!eqAddressStarknet(current.config.defaultIsm.deployed.address, artifact.config.defaultIsm.deployed.address)) {
            txs.push({
                annotation: `Updating mailbox default ISM`,
                ...(await this.signer.getSetDefaultIsmTransaction({
                    signer: this.signer.getSignerAddress(),
                    mailboxAddress: artifact.deployed.address,
                    ismAddress: normalizeStarknetAddress(artifact.config.defaultIsm.deployed.address),
                })),
            });
        }
        if (!eqAddressStarknet(current.config.defaultHook.deployed.address, artifact.config.defaultHook.deployed.address)) {
            txs.push({
                annotation: `Updating mailbox default hook`,
                ...(await this.signer.getSetDefaultHookTransaction({
                    signer: this.signer.getSignerAddress(),
                    mailboxAddress: artifact.deployed.address,
                    hookAddress: normalizeStarknetAddress(artifact.config.defaultHook.deployed.address),
                })),
            });
        }
        if (!eqAddressStarknet(current.config.requiredHook.deployed.address, artifact.config.requiredHook.deployed.address)) {
            txs.push({
                annotation: `Updating mailbox required hook`,
                ...(await this.signer.getSetRequiredHookTransaction({
                    signer: this.signer.getSignerAddress(),
                    mailboxAddress: artifact.deployed.address,
                    hookAddress: normalizeStarknetAddress(artifact.config.requiredHook.deployed.address),
                })),
            });
        }
        if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
            txs.push({
                annotation: `Updating mailbox owner`,
                ...(await this.signer.getSetMailboxOwnerTransaction({
                    signer: this.signer.getSignerAddress(),
                    mailboxAddress: artifact.deployed.address,
                    newOwner: normalizeStarknetAddress(artifact.config.owner),
                })),
            });
        }
        return txs;
    }
}
export class StarknetMailboxArtifactManager {
    provider;
    domainId;
    constructor(chainMetadata) {
        this.provider = StarknetProvider.connect((chainMetadata.rpcUrls ?? []).map((rpc) => rpc.http), chainMetadata.chainId, { metadata: chainMetadata });
        this.domainId = chainMetadata.domainId;
    }
    async readMailbox(address) {
        const reader = this.createReader('mailbox');
        return reader.read(address);
    }
    createReader(_type) {
        return new StarknetMailboxReader(this.provider);
    }
    createWriter(_type, signer) {
        return new StarknetMailboxWriter(this.provider, signer, this.domainId);
    }
}
//# sourceMappingURL=mailbox-artifact-manager.js.map