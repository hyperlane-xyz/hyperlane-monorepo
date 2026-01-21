import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  AltVM,
  ChainMetadataForAltVM,
  ITransactionSubmitter,
  MinimumRequiredGasByAction,
  ProtocolProvider,
  SignerConfig,
  TransactionSubmitterConfig,
} from '@hyperlane-xyz/provider-sdk';
import { IProvider } from '@hyperlane-xyz/provider-sdk/altvm';
import { IRawHookArtifactManager } from '@hyperlane-xyz/provider-sdk/hook';
import { IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { IRawWarpArtifactManager } from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import { RadixHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { RadixIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { RadixBase } from '../utils/base.js';
import { RadixWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import { NETWORKS, RadixProvider } from './provider.js';
import { RadixSigner } from './signer.js';

const DEFAULT_GAS_MULTIPLIER = 1.2;

export class RadixProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);
    return RadixProvider.connect(rpcUrls, chainMetadata.chainId, {
      metadata: chainMetadata,
    });
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);

    const { privateKey } = config;

    return RadixSigner.connectWithSigner(rpcUrls, privateKey, {
      metadata: chainMetadata,
    });
  }

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    _chainMetadata: ChainMetadataForAltVM,
    _config: TConfig,
  ): Promise<ITransactionSubmitter> {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
  }

  createIsmArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawIsmArtifactManager {
    assert(chainMetadata.gatewayUrls, 'gateway urls undefined');

    const networkId = parseInt(chainMetadata.chainId.toString());
    const gatewayUrl = chainMetadata.gatewayUrls[0]?.http;

    assert(gatewayUrl, 'gateway url undefined');

    // Get package address from metadata first
    let packageAddress = chainMetadata.packageAddress;

    // If not in metadata, try to get from NETWORKS config as fallback
    if (!packageAddress) {
      const networkBaseConfig = NETWORKS[networkId];
      assert(
        networkBaseConfig,
        `Network with id ${networkId} not supported and no packageAddress provided in chain metadata. Supported network ids: ${Object.keys(NETWORKS).join(', ')}`,
      );
      packageAddress = networkBaseConfig.packageAddress;
    }

    assert(
      packageAddress,
      `Expected package address to be defined for radix network with id ${networkId}`,
    );

    // Initialize the Gateway API client
    const gateway = GatewayApiClient.initialize({
      applicationName: 'hyperlane',
      basePath: gatewayUrl,
      networkId,
    });

    // Create RadixBase instance with default gas multiplier
    const base = new RadixBase(
      networkId,
      gateway,
      DEFAULT_GAS_MULTIPLIER,
      packageAddress,
    );

    return new RadixIsmArtifactManager(gateway, base);
  }

  createHookArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string },
  ): IRawHookArtifactManager {
    assert(chainMetadata.gatewayUrls, 'gateway urls undefined');

    const networkId = parseInt(chainMetadata.chainId.toString());
    const gatewayUrl = chainMetadata.gatewayUrls[0]?.http;

    assert(gatewayUrl, 'gateway url undefined');

    // Get package address from metadata first
    let packageAddress = chainMetadata.packageAddress;

    // If not in metadata, try to get from NETWORKS config as fallback
    if (!packageAddress) {
      const networkBaseConfig = NETWORKS[networkId];
      assert(
        networkBaseConfig,
        `Network with id ${networkId} not supported and no packageAddress provided in chain metadata. Supported network ids: ${Object.keys(NETWORKS).join(', ')}`,
      );
      packageAddress = networkBaseConfig.packageAddress;
    }

    assert(
      packageAddress,
      `Expected package address to be defined for radix network with id ${networkId}`,
    );

    // Initialize the Gateway API client
    const gateway = GatewayApiClient.initialize({
      applicationName: 'hyperlane',
      basePath: gatewayUrl,
      networkId,
    });

    // Create RadixBase instance with default gas multiplier
    const base = new RadixBase(
      networkId,
      gateway,
      DEFAULT_GAS_MULTIPLIER,
      packageAddress,
    );

    // Get native token denom from chain metadata
    const nativeTokenDenom = chainMetadata.nativeToken?.denom || '';

    // Get mailbox from context if provided, otherwise empty string for read-only operations
    const mailboxAddress = context?.mailbox || '';

    return new RadixHookArtifactManager(
      gateway,
      base,
      mailboxAddress,
      nativeTokenDenom,
    );
  }

  createWarpArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string },
  ): IRawWarpArtifactManager {
    assert(chainMetadata.gatewayUrls, 'gateway urls undefined');

    const networkId = parseInt(chainMetadata.chainId.toString());
    const gatewayUrl = chainMetadata.gatewayUrls[0]?.http;

    assert(gatewayUrl, 'gateway url undefined');

    // Get package address from metadata first
    let packageAddress = chainMetadata.packageAddress;

    // If not in metadata, try to get from NETWORKS config as fallback
    if (!packageAddress) {
      const networkBaseConfig = NETWORKS[networkId];
      assert(
        networkBaseConfig,
        `Network with id ${networkId} not supported and no packageAddress provided in chain metadata. Supported network ids: ${Object.keys(NETWORKS).join(', ')}`,
      );
      packageAddress = networkBaseConfig.packageAddress;
    }

    assert(
      packageAddress,
      `Expected package address to be defined for radix network with id ${networkId}`,
    );

    // Initialize the Gateway API client
    const gateway = GatewayApiClient.initialize({
      applicationName: 'hyperlane',
      basePath: gatewayUrl,
      networkId,
    });

    // Create RadixBase instance with default gas multiplier
    const base = new RadixBase(
      networkId,
      gateway,
      DEFAULT_GAS_MULTIPLIER,
      packageAddress,
    );

    return new RadixWarpArtifactManager(gateway, base);
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: 0n,
      WARP_DEPLOY_GAS: 0n,
      TEST_SEND_GAS: 0n,
      AVS_GAS: 0n,
    };
  }
}
