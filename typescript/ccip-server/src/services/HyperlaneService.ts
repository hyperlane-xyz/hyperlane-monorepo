import axios from 'axios';
import { info } from 'console';
import { Message, MessageTx } from 'hyperlane-explorer/src/types';

import { Requestor } from './common/Requestor';

// These types are copied from hyperlane-explorer. TODO: export them so this file can use them directly.
interface ApiResult<R> {
  status: '0' | '1';
  message: string;
  result: R;
}

enum API_ACTION {
  GetMessages = 'get-messages',
}

class HyperlaneService extends Requestor {
  constructor(readonly baseUrl: string) {
    super(axios, '');
  }

  /**
   * Makes a request to the Explorer API to get the block info by message Id. Throws if request fails, or no results
   * @param id: Message id to look up
   */
  async getOriginBlockByMessageId(id: string): Promise<MessageTx> {
    info(`Fetching block for id: ${id}`);
    const { data }: { data: ApiResult<Message[]> } = await this.get(
      this.baseUrl,
      {
        module: 'message',
        action: API_ACTION.GetMessages,
        id,
      },
    );
    if (data.message === 'OK' && data.result.length > 0) {
      return data.result[0].origin;
    }

    throw new Error(data.message);
  }
}

export { HyperlaneService };
