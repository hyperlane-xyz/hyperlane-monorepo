import { Uint53 } from '@cosmjs/math';
import { Registry } from '@cosmjs/proto-signing';
import {
  QueryClient,
  StargateClient,
  defaultRegistryTypes,
  setupBankExtension,
} from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { setupCoreExtension } from '../hyperlane/core/query.js';
import { setupInterchainSecurityExtension } from '../hyperlane/interchain_security/query.js';
import { setupPostDispatchExtension } from '../hyperlane/post_dispatch/query.js';
import { setupWarpExtension } from '../hyperlane/warp/query.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';

export class HyperlaneModuleClient extends StargateClient {
  query;
  registry;
  constructor(cometClient, options) {
    super(cometClient, options);
    this.query = QueryClient.withExtensions(
      cometClient,
      setupBankExtension,
      setupCoreExtension,
      setupInterchainSecurityExtension,
      setupPostDispatchExtension,
      setupWarpExtension,
    );
    this.registry = new Registry([...defaultRegistryTypes]);
    // register all the custom tx types
    Object.values(R).forEach(({ proto }) => {
      this.registry.register(proto.type, proto.converter);
    });
  }
  static async connect(endpoint, options = {}) {
    const client = await connectComet(endpoint);
    return new HyperlaneModuleClient(client, options);
  }
  async simulate(signerAddress, signerPubKey, messages, memo) {
    const queryClient = this.getQueryClient();
    const { sequence } = await this.getSequence(signerAddress);
    const { gasInfo } = await queryClient.tx.simulate(
      messages,
      memo,
      signerPubKey,
      sequence,
    );
    return Uint53.fromString(gasInfo?.gasUsed.toString() ?? '0').toNumber();
  }
}
//# sourceMappingURL=client.js.map
