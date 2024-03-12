import { info } from 'console';
import { Message, MessageTx } from 'hyperlane-explorer/src/types';

// These types are copied from hyperlane-explorer. TODO: export them so this file can use them directly.
interface ApiResult<R> {
  status: '0' | '1';
  message: string;
  result: R;
}

enum API_ACTION {
  GetMessages = 'get-messages',
}

enum API_MODULE {
  Message = 'message',
}

class HyperlaneService {
  constructor(readonly baseUrl: string) {}

  /**
   * Makes a request to the Explorer API to get the block info by message Id. Throws if request fails, or no results
   * @param id: Message id to look up
   */
  async getOriginBlockByMessageId(id: string): Promise<MessageTx> {
    info(`Fetching block for id: ${id}`);
    const response = await fetch(
      `${this.baseUrl}?module=${API_MODULE.Message}&action=${API_ACTION.GetMessages}&id=${id}`,
    );
    const responseAsJson: ApiResult<Message[]> = await response.json();
    if (responseAsJson.status === '1') {
      if (responseAsJson.result.length === 0) {
        throw new Error(`No message found for id: ${id}`);
      }
      return responseAsJson.result[0].origin;
    } else {
      // Only happens if the module and action url parameters are malformed, which should not happen.
      throw new Error(responseAsJson.message);
    }
  }
}

export { HyperlaneService };
