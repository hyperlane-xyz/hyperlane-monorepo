import type { Logger } from 'pino';

import type {
  ExplorerMessage,
  IExplorerClient,
  RebalanceActionQueryParams,
  UserTransferQueryParams,
} from '../utils/ExplorerClient.js';

export const ID_A =
  '0x8960c5e41eb0d91973140ebc196892f5f07f512dd86047e8536e71424462c5d3';
export const ID_B =
  '0xdae65a8dd678bf8ea03faed7d53b99e52f5bdbae7c95834eff009cc37a18103c';
export const ID_C =
  '0x1c3b5f0e2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70';

export const PARAMS: UserTransferQueryParams = {
  routersByDomain: { 1: '0x67899664446ccfadf75e0d3f5668be262acd1069' },
  excludeTxSenders: ['0x995a921d333029512aa166885856c8af760e9381'],
};

export const REBALANCE_PARAMS: RebalanceActionQueryParams = {
  bridges: ['0x867a19a5b257bcb99e1840de2ef852268efd5e46'],
  routersByDomain: PARAMS.routersByDomain,
  rebalancerAddress: '0x995a921d333029512aa166885856c8af760e9381',
};

export function buildMessage(msgId: string): ExplorerMessage {
  return {
    msg_id: msgId,
    origin_domain_id: 42161,
    destination_domain_id: 1,
    sender: '0x867a19a5b257bcb99e1840de2ef852268efd5e46',
    recipient: '0x67899664446ccfadf75e0d3f5668be262acd1069',
    origin_tx_hash:
      '0x5e3c1f6a3c1a7f86e0f2d5e9c9c1b8d1e1e7e2b6c4d8a9f0e1d2c3b4a5968778',
    origin_tx_sender: '0x995a921d333029512aa166885856c8af760e9381',
    origin_tx_recipient: '0x867a19a5b257bcb99e1840de2ef852268efd5e46',
    is_delivered: false,
    message_body: `0x${'00'.repeat(63)}64`,
    send_occurred_at: null,
  };
}

export class StubExplorerClient implements IExplorerClient {
  readonly userTransferParams: UserTransferQueryParams[] = [];
  rebalanceActions: ExplorerMessage[] = [buildMessage(ID_C)];

  constructor(public userTransfers: ExplorerMessage[]) {}

  async getInflightUserTransfers(
    params: UserTransferQueryParams,
    _logger: Logger,
  ): Promise<ExplorerMessage[]> {
    this.userTransferParams.push(params);
    return this.userTransfers;
  }

  async getInflightRebalanceActions(
    _params: RebalanceActionQueryParams,
    _logger: Logger,
  ): Promise<ExplorerMessage[]> {
    return this.rebalanceActions;
  }
}
