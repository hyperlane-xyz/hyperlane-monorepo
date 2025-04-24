import { Pubkey } from '@cosmjs/amino';
import { Registry } from '@cosmjs/proto-signing';
import {
  BankExtension,
  QueryClient,
  StargateClient,
  StargateClientOptions,
} from '@cosmjs/stargate';
import { CometClient, HttpEndpoint } from '@cosmjs/tendermint-rpc';

import { CoreExtension } from '../hyperlane/core/query.js';
import { InterchainSecurityExtension } from '../hyperlane/interchain_security/query.js';
import { PostDispatchExtension } from '../hyperlane/post_dispatch/query.js';
import { WarpExtension } from '../hyperlane/warp/query.js';

export type HyperlaneQueryClient = QueryClient &
  BankExtension &
  WarpExtension &
  CoreExtension &
  InterchainSecurityExtension &
  PostDispatchExtension;
export declare class HyperlaneModuleClient extends StargateClient {
  readonly query: HyperlaneQueryClient;
  registry: Registry;
  protected constructor(
    cometClient: CometClient,
    options: StargateClientOptions,
  );
  static connect(
    endpoint: string | HttpEndpoint,
    options?: StargateClientOptions,
  ): Promise<HyperlaneModuleClient>;
  simulate(
    signerAddress: string,
    signerPubKey: Pubkey,
    messages: any[],
    memo: string | undefined,
  ): Promise<number>;
}
//# sourceMappingURL=client.d.ts.map
