import { assert } from '@hyperlane-xyz/utils';
import { TronProvider } from './provider.js';
import { TronSigner } from './signer.js';
/**
 * TronProtocolProvider implements the ProtocolProvider interface for Tron.
 * This enables Tron to be registered with the protocol registry and used
 * by the CLI and deploy tooling.
 */
export class TronProtocolProvider {
    createProvider(chainMetadata) {
        assert(chainMetadata.rpcUrls, 'rpc urls undefined');
        const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);
        return TronProvider.connect(rpcUrls, chainMetadata.chainId, {
            metadata: chainMetadata,
        });
    }
    async createSigner(chainMetadata, config) {
        assert(chainMetadata.rpcUrls, 'rpc urls undefined');
        const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);
        const { privateKey } = config;
        // TronSigner returns TronSDKTransaction/TronSDKReceipt but they're compatible
        // with the generic AnnotatedTx/TxReceipt interfaces
        const signer = await TronSigner.connectWithSigner(rpcUrls, privateKey, {
            metadata: chainMetadata,
        });
        return signer;
    }
    createSubmitter(_chainMetadata, _config) {
        throw new Error('Transaction submitter not implemented for Tron');
    }
    createIsmArtifactManager(_chainMetadata) {
        // Tron uses the same Solidity contracts as EVM, so ISM artifact management
        // would be similar. For now, throw until we implement ISM factory deployment.
        throw new Error('ISM artifact manager not yet implemented for Tron');
    }
    createHookArtifactManager(_chainMetadata, _context) {
        // Tron uses the same Solidity contracts as EVM, so Hook artifact management
        // would be similar. For now, throw until we implement Hook factory deployment.
        throw new Error('Hook artifact manager not yet implemented for Tron');
    }
    getMinGas() {
        // Tron uses energy/bandwidth model. These are rough estimates in TRX (sun units).
        // 1 TRX = 1,000,000 sun
        return {
            CORE_DEPLOY_GAS: BigInt(500_000_000), // ~500 TRX for core deployment
            WARP_DEPLOY_GAS: BigInt(200_000_000), // ~200 TRX for warp route
            ISM_DEPLOY_GAS: BigInt(100_000_000), // ~100 TRX for ISM
            TEST_SEND_GAS: BigInt(50_000_000), // ~50 TRX for test send
            AVS_GAS: BigInt(0), // Not applicable
        };
    }
}
//# sourceMappingURL=protocol.js.map