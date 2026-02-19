import { assert } from '@hyperlane-xyz/utils';
import { StarknetHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { StarknetMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import { StarknetValidatorAnnounceArtifactManager } from '../validator-announce/validator-announce-artifact-manager.js';
import { StarknetProvider } from './provider.js';
import { StarknetSigner } from './signer.js';
export class StarknetProtocolProvider {
    createProvider(chainMetadata) {
        const rpcUrls = (chainMetadata.rpcUrls ?? []).map(({ http }) => http);
        assert(rpcUrls.length > 0, 'rpc urls undefined for Starknet');
        return Promise.resolve(StarknetProvider.connect(rpcUrls, chainMetadata.chainId, {
            metadata: chainMetadata,
        }));
    }
    async createSigner(chainMetadata, config) {
        const rpcUrls = (chainMetadata.rpcUrls ?? []).map(({ http }) => http);
        assert(rpcUrls.length > 0, 'rpc urls undefined for Starknet');
        assert(config.privateKey, 'privateKey missing for Starknet signer');
        assert(config.accountAddress, 'accountAddress missing for Starknet signer');
        return StarknetSigner.connectWithSigner(rpcUrls, config.privateKey, {
            metadata: chainMetadata,
            accountAddress: config.accountAddress,
        });
    }
    createSubmitter(_chainMetadata, _config) {
        throw new Error('Not implemented');
    }
    createIsmArtifactManager(chainMetadata) {
        return new StarknetIsmArtifactManager(chainMetadata);
    }
    createHookArtifactManager(chainMetadata, context) {
        return new StarknetHookArtifactManager(chainMetadata, context);
    }
    createMailboxArtifactManager(chainMetadata) {
        return new StarknetMailboxArtifactManager(chainMetadata);
    }
    createValidatorAnnounceArtifactManager(chainMetadata) {
        return new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    }
    getMinGas() {
        return {
            CORE_DEPLOY_GAS: 0n,
            WARP_DEPLOY_GAS: 0n,
            TEST_SEND_GAS: 0n,
            AVS_GAS: 0n,
            ISM_DEPLOY_GAS: 0n,
        };
    }
}
//# sourceMappingURL=protocol.js.map