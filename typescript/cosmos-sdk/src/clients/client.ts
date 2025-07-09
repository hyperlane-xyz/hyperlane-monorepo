import { Pubkey } from '@cosmjs/amino';
import { Uint53 } from '@cosmjs/math';
import { Registry } from '@cosmjs/proto-signing';
import {
  BankExtension,
  QueryClient,
  StargateClient,
  StargateClientOptions,
  defaultRegistryTypes,
  setupBankExtension,
} from '@cosmjs/stargate';
import {
  CometClient,
  HttpEndpoint,
  connectComet,
} from '@cosmjs/tendermint-rpc';

import { CoreExtension, setupCoreExtension } from '../hyperlane/core/query.js';
import {
  InterchainSecurityExtension,
  setupInterchainSecurityExtension,
} from '../hyperlane/interchain_security/query.js';
import {
  PostDispatchExtension,
  setupPostDispatchExtension,
} from '../hyperlane/post_dispatch/query.js';
import { WarpExtension, setupWarpExtension } from '../hyperlane/warp/query.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as R } from '../registry.js';

export type HyperlaneQueryClient = QueryClient &
  BankExtension &
  WarpExtension &
  CoreExtension &
  InterchainSecurityExtension &
  PostDispatchExtension;

export class HyperlaneModuleClient extends StargateClient {
  readonly query: HyperlaneQueryClient;
  public registry: Registry;

  protected constructor(
    cometClient: CometClient,
    options: StargateClientOptions,
  ) {
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

  static async connect(
    endpoint: string | HttpEndpoint,
    options: StargateClientOptions = {},
  ): Promise<HyperlaneModuleClient> {
    const client = await connectComet(endpoint);
    return new HyperlaneModuleClient(client, options);
  }

  public async simulate(
    signerAddress: string,
    signerPubKey: Pubkey,
    messages: any[],
    memo: string | undefined,
  ): Promise<number> {
    const queryClient = this.getQueryClient()!;

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
