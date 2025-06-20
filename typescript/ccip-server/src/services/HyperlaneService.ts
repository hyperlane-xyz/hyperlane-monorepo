import { Logger } from 'pino';

import { PrometheusMetrics } from '../utils/prometheus.js';

import { Message, MessageTx } from './explorerTypes.js';

// These types are copied from hyperlane-explorer. TODO: export them so this file can use them directly.
interface ApiResult<R> {
  status: '0' | '1';
  message: string;
  result: R;
}

enum API_ACTION {
  GetMessages = 'get-messages',
}

class HyperlaneService {
  logger: Logger;

  constructor(
    readonly baseUrl: string,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  /**
   * Makes a request to the Explorer API to get the block info by message Id. Throws if request fails, or no results
   * @param id: Message id to look up
   * @param logger: Optional logger for request context
   */
  async getOriginBlockByMessageId(
    id: string,
    logger?: Logger,
  ): Promise<MessageTx> {
    const log = (logger || this.logger).child({
      component: 'HyperlaneService',
    });

    log.info({ messageId: id }, 'Fetching block for message ID');
    const response = await fetch(
      `${this.baseUrl}?module=message&action=${API_ACTION.GetMessages}&id=${id}`,
    );
    const responseAsJson: ApiResult<Message[]> = await response.json();
    if (responseAsJson.status === '1') {
      return responseAsJson.result[0]?.origin;
    } else {
      log.warn(
        {
          messageId: id,
          responseAsJson,
        },
        'Hyperlane service: GraphQL search request returned no results',
      );
      throw new Error(responseAsJson.message);
    }
  }

  /**
   * Makes a request to the Explorer API to get the origin transaction hash. Throws if request fails, or no results
   * @param id: Message id to look up
   * @param logger: Optional logger for request context
   */
  async getOriginTransactionHashByMessageId(
    id: string,
    logger?: Logger,
  ): Promise<string> {
    const log = (logger || this.logger).child({
      component: 'HyperlaneService',
    });

    log.info({ messageId: id }, 'Fetching transaction hash for message ID');

    const body = JSON.stringify({
      query: `query ($search: bytea) {
        message_view(
            where: { msg_id: {_eq: $search} }
            limit: 1
        ) {
            id
            msg_id
            nonce
            sender
            recipient
            is_delivered
            origin_tx_id
            origin_tx_hash
            origin_tx_sender
          }
    }`,
      variables: {
        search: id.replace('0x', '\\x'),
      },
    });

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    });

    if (response.status === 500) {
      log.error(
        {
          messageId: id,
        },
        'Hyperlane service: GraphQL search request returned 500 status code',
      );
      PrometheusMetrics.logUnhandledError();
      throw new Error(
        'Hyperlane service: GraphQL search request returned 500 status code',
      );
    }

    const responseAsJson = (await response.json())['data']['message_view'];

    if (responseAsJson.length > 0) {
      const txHash = responseAsJson[0]?.origin_tx_hash.replace('\\x', '0x');
      log.info(
        { messageId: id, txHash },
        'Successfully retrieved transaction hash',
      );
      return txHash;
    } else {
      log.warn(
        {
          messageId: id,
          responseAsJson,
        },
        'Hyperlane service: GraphQL search request returned no results',
      );
      throw new Error(
        'Hyperlane service: GraphQL search request returned no results',
      );
    }
  }
}

export { HyperlaneService };
