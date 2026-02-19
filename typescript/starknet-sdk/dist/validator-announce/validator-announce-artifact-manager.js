import { ArtifactState, } from '@hyperlane-xyz/provider-sdk/artifact';
import { StarknetContractName, callContract, getStarknetContract, normalizeStarknetAddressSafe, } from '../contracts.js';
class StarknetValidatorAnnounceReader {
    async read(address) {
        const normalizedAddress = normalizeStarknetAddressSafe(address);
        const validatorAnnounce = getStarknetContract(StarknetContractName.VALIDATOR_ANNOUNCE, normalizedAddress);
        const mailboxAddress = await callContract(validatorAnnounce, 'mailbox').catch(() => '');
        return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
                mailboxAddress: mailboxAddress
                    ? normalizeStarknetAddressSafe(mailboxAddress)
                    : '',
            },
            deployed: {
                address: normalizedAddress,
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
                    address: normalizeStarknetAddressSafe(deployed.validatorAnnounceId),
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
    constructor(_chainMetadata) { }
    readValidatorAnnounce(address) {
        return this.createReader('validatorAnnounce').read(address);
    }
    createReader(type) {
        if (type !== 'validatorAnnounce') {
            throw new Error(`Unsupported Starknet validator announce type: ${type}`);
        }
        return new StarknetValidatorAnnounceReader();
    }
    createWriter(type, signer) {
        if (type !== 'validatorAnnounce') {
            throw new Error(`Unsupported Starknet validator announce type: ${type}`);
        }
        return new StarknetValidatorAnnounceWriter(signer);
    }
}
//# sourceMappingURL=validator-announce-artifact-manager.js.map