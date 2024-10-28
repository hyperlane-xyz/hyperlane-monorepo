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
}

export { HyperlaneService };
