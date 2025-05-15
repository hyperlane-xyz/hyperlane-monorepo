import { Message, MessageTx } from './explorerTypes';

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
  constructor(readonly baseUrl: string) {}

  /**
   * Makes a request to the Explorer API to get the block info by message Id. Throws if request fails, or no results
   * @param id: Message id to look up
   */
  async getOriginBlockByMessageId(id: string): Promise<MessageTx> {
    console.info(`Fetching block for id: ${id}`);
    const response = await fetch(
      `${this.baseUrl}?module=message&action=${API_ACTION.GetMessages}&id=${id}`,
    );
    const responseAsJson: ApiResult<Message[]> = await response.json();
    if (responseAsJson.status === '1') {
      return responseAsJson.result[0]?.origin;
    } else {
      throw new Error(responseAsJson.message);
    }
  }

  /**
   * Makes a request to the Explorer API to get the origin transaction hash. Throws if request fails, or no results
   * @param id: Message id to look up
   */
  async getOriginTransactionHashByMessageId(id: string): Promise<string> {
    console.info(`Fetching transaction hash for id: ${id}`);

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

    if (response.status >= 400 && response.status < 500) {
      throw new Error('Invalid message id');
    }

    const responseAsJson = (await response.json())['data']['message_view'];

    if (responseAsJson.length > 0) {
      return responseAsJson[0]?.origin_tx_hash.replace('\\x', '0x');
    } else {
      throw new Error('Hyperlane service: GraphQL request failed');
    }
  }
}

export { HyperlaneService };
