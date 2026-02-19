import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState, isArtifactDeployed, isArtifactUnderived, } from '@hyperlane-xyz/provider-sdk/artifact';
import { eqAddressStarknet } from '@hyperlane-xyz/utils';
import { StarknetProvider } from '../clients/provider.js';
import { normalizeStarknetAddress } from '../contracts.js';
class StarknetTestIsmReader {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async read(address) {
        const noop = await this.provider.getNoopIsm({ ismAddress: address });
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: { type: AltVM.IsmType.TEST_ISM },
            deployed: {
                address: noop.address,
            },
        };
    }
}
class StarknetTestIsmWriter extends StarknetTestIsmReader {
    signer;
    constructor(provider, signer) {
        super(provider);
        this.signer = signer;
    }
    async create(artifact) {
        const created = await this.signer.createNoopIsm({});
        return [
            {
                artifactState: ArtifactState.DEPLOYED,
                config: artifact.config,
                deployed: { address: created.ismAddress },
            },
            [],
        ];
    }
    async update(_artifact) {
        return [];
    }
}
class StarknetMerkleRootMultisigIsmReader {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async read(address) {
        const ism = await this.provider.getMerkleRootMultisigIsm({
            ismAddress: address,
        });
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                type: AltVM.IsmType.MERKLE_ROOT_MULTISIG,
                validators: ism.validators,
                threshold: ism.threshold,
            },
            deployed: {
                address: ism.address,
            },
        };
    }
}
class StarknetMerkleRootMultisigIsmWriter extends StarknetMerkleRootMultisigIsmReader {
    signer;
    constructor(provider, signer) {
        super(provider);
        this.signer = signer;
    }
    async create(artifact) {
        const created = await this.signer.createMerkleRootMultisigIsm({
            validators: artifact.config.validators,
            threshold: artifact.config.threshold,
        });
        return [
            {
                artifactState: ArtifactState.DEPLOYED,
                config: artifact.config,
                deployed: { address: created.ismAddress },
            },
            [],
        ];
    }
    async update(_artifact) {
        return [];
    }
}
class StarknetMessageIdMultisigIsmReader {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async read(address) {
        const ism = await this.provider.getMessageIdMultisigIsm({
            ismAddress: address,
        });
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                type: AltVM.IsmType.MESSAGE_ID_MULTISIG,
                validators: ism.validators,
                threshold: ism.threshold,
            },
            deployed: {
                address: ism.address,
            },
        };
    }
}
class StarknetMessageIdMultisigIsmWriter extends StarknetMessageIdMultisigIsmReader {
    signer;
    constructor(provider, signer) {
        super(provider);
        this.signer = signer;
    }
    async create(artifact) {
        const created = await this.signer.createMessageIdMultisigIsm({
            validators: artifact.config.validators,
            threshold: artifact.config.threshold,
        });
        return [
            {
                artifactState: ArtifactState.DEPLOYED,
                config: artifact.config,
                deployed: { address: created.ismAddress },
            },
            [],
        ];
    }
    async update(_artifact) {
        return [];
    }
}
class StarknetRoutingIsmReader {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async read(address) {
        const routing = await this.provider.getRoutingIsm({ ismAddress: address });
        const domains = {};
        for (const route of routing.routes) {
            domains[route.domainId] = {
                artifactState: ArtifactState.UNDERIVED,
                deployed: { address: route.ismAddress },
            };
        }
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                type: AltVM.IsmType.ROUTING,
                owner: routing.owner,
                domains,
            },
            deployed: { address: routing.address },
        };
    }
}
class StarknetRoutingIsmWriter extends StarknetRoutingIsmReader {
    signer;
    constructor(provider, signer) {
        super(provider);
        this.signer = signer;
    }
    async create(artifact) {
        const routes = Object.entries(artifact.config.domains).map(([domainId, domainIsm]) => {
            const domainArtifact = domainIsm;
            if (isArtifactUnderived(domainArtifact) ||
                isArtifactDeployed(domainArtifact)) {
                return {
                    domainId: Number(domainId),
                    ismAddress: domainArtifact.deployed.address,
                };
            }
            throw new Error(`Routing ISM domain ${domainId} must be deployed before Starknet raw routing deployment`);
        });
        const created = await this.signer.createRoutingIsm({ routes });
        if (!eqAddressStarknet(artifact.config.owner, this.signer.getSignerAddress())) {
            await this.signer.setRoutingIsmOwner({
                ismAddress: created.ismAddress,
                newOwner: artifact.config.owner,
            });
        }
        return [
            {
                artifactState: ArtifactState.DEPLOYED,
                config: artifact.config,
                deployed: { address: created.ismAddress },
            },
            [],
        ];
    }
    async update(artifact) {
        const current = await this.read(artifact.deployed.address);
        const expectedRoutes = Object.entries(artifact.config.domains).map(([domainId, domainIsm]) => {
            const domainArtifact = domainIsm;
            if (isArtifactUnderived(domainArtifact) ||
                isArtifactDeployed(domainArtifact)) {
                return {
                    domainId: Number(domainId),
                    ismAddress: normalizeStarknetAddress(domainArtifact.deployed.address),
                };
            }
            throw new Error(`Routing ISM domain ${domainId} has invalid state`);
        });
        const actualByDomain = new Map(Object.entries(current.config.domains).map(([domainId, domainIsm]) => [
            Number(domainId),
            normalizeStarknetAddress(domainIsm.deployed.address),
        ]));
        const expectedByDomain = new Map(expectedRoutes.map((route) => [route.domainId, route.ismAddress]));
        const updateTxs = [];
        for (const route of expectedRoutes) {
            const actualAddress = actualByDomain.get(route.domainId);
            if (!actualAddress ||
                !eqAddressStarknet(actualAddress, route.ismAddress)) {
                updateTxs.push({
                    annotation: `Setting routing ISM route ${route.domainId}`,
                    ...(await this.signer.getSetRoutingIsmRouteTransaction({
                        signer: this.signer.getSignerAddress(),
                        ismAddress: artifact.deployed.address,
                        route,
                    })),
                });
            }
        }
        for (const [domainId] of actualByDomain) {
            if (!expectedByDomain.has(domainId)) {
                updateTxs.push({
                    annotation: `Removing routing ISM route ${domainId}`,
                    ...(await this.signer.getRemoveRoutingIsmRouteTransaction({
                        signer: this.signer.getSignerAddress(),
                        ismAddress: artifact.deployed.address,
                        domainId,
                    })),
                });
            }
        }
        if (!eqAddressStarknet(current.config.owner, artifact.config.owner)) {
            updateTxs.push({
                annotation: `Updating routing ISM owner`,
                ...(await this.signer.getSetRoutingIsmOwnerTransaction({
                    signer: this.signer.getSignerAddress(),
                    ismAddress: artifact.deployed.address,
                    newOwner: artifact.config.owner,
                })),
            });
        }
        return updateTxs;
    }
}
export class StarknetIsmArtifactManager {
    provider;
    constructor(chainMetadata) {
        this.provider = StarknetProvider.connect((chainMetadata.rpcUrls ?? []).map((rpc) => rpc.http), chainMetadata.chainId, { metadata: chainMetadata });
    }
    async readIsm(address) {
        const type = await this.provider.getIsmType({ ismAddress: address });
        const reader = this.createReader(type);
        return reader.read(address);
    }
    createReader(type) {
        const readers = {
            testIsm: () => new StarknetTestIsmReader(this.provider),
            merkleRootMultisigIsm: () => new StarknetMerkleRootMultisigIsmReader(this.provider),
            messageIdMultisigIsm: () => new StarknetMessageIdMultisigIsmReader(this.provider),
            domainRoutingIsm: () => new StarknetRoutingIsmReader(this.provider),
        };
        const readerFactory = readers[type];
        if (!readerFactory) {
            throw new Error(`Unsupported Starknet ISM type: ${type}`);
        }
        return readerFactory();
    }
    createWriter(type, signer) {
        const starknetSigner = signer;
        const writers = {
            testIsm: () => new StarknetTestIsmWriter(this.provider, starknetSigner),
            merkleRootMultisigIsm: () => new StarknetMerkleRootMultisigIsmWriter(this.provider, starknetSigner),
            messageIdMultisigIsm: () => new StarknetMessageIdMultisigIsmWriter(this.provider, starknetSigner),
            domainRoutingIsm: () => new StarknetRoutingIsmWriter(this.provider, starknetSigner),
        };
        const writerFactory = writers[type];
        if (!writerFactory) {
            throw new Error(`Unsupported Starknet ISM type: ${type}`);
        }
        return writerFactory();
    }
}
//# sourceMappingURL=ism-artifact-manager.js.map