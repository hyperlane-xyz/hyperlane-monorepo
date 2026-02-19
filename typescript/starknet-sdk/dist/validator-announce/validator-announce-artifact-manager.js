import { ArtifactState, } from '@hyperlane-xyz/provider-sdk/artifact';
import { StarknetProvider } from '../clients/provider.js';
class StarknetValidatorAnnounceReader {
    async read(address) {
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                mailboxAddress: '',
            },
            deployed: {
                address,
            },
        };
    }
}
class StarknetValidatorAnnounceWriter extends StarknetValidatorAnnounceReader {
    signer;
    constructor(signer) {
        super();
        this.signer = signer;
    }
    async create(artifact) {
        const deployed = await this.signer.createValidatorAnnounce({
            mailboxAddress: artifact.config.mailboxAddress,
        });
        return [
            {
                artifactState: ArtifactState.DEPLOYED,
                config: artifact.config,
                deployed: {
                    address: deployed.validatorAnnounceId,
                },
            },
            [],
        ];
    }
    async update(_artifact) {
        return [];
    }
}
export class StarknetValidatorAnnounceArtifactManager {
    constructor(chainMetadata) {
        StarknetProvider.connect((chainMetadata.rpcUrls ?? []).map((rpc) => rpc.http), chainMetadata.chainId, { metadata: chainMetadata });
    }
    async readValidatorAnnounce(address) {
        return this.createReader('validatorAnnounce').read(address);
    }
    createReader(_type) {
        return new StarknetValidatorAnnounceReader();
    }
    createWriter(_type, signer) {
        return new StarknetValidatorAnnounceWriter(signer);
    }
}
//# sourceMappingURL=validator-announce-artifact-manager.js.map