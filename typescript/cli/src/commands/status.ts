import { CommandModuleWithWriteContext } from '../context/types.js';
import { checkMessageStatus } from '../status/message.js';

import { MessageOptionsArgTypes, messageOptions } from './send.js';

export const statusCommand: CommandModuleWithWriteContext<
  MessageOptionsArgTypes & { id?: string } & { dispatchTx?: string }
> = {
  command: 'status',
  describe: 'Check status of a message',
  builder: {
    ...messageOptions,
    id: {
      type: 'string',
      description: 'Message ID',
    },
    dispatchTx: {
      type: 'string',
      description: 'Dispatch transaction hash',
    },
  },
  handler: async ({ context, origin, id, relay, dispatchTx }) => {
    await checkMessageStatus({
      context,
      dispatchTx,
      messageId: id,
      origin,
      selfRelay: relay,
    });
    process.exit(0);
  },
};
