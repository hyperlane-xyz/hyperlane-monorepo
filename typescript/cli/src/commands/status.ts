import { CommandModuleWithContext } from '../context/types.js';
import { checkMessageStatus } from '../status/message.js';

import { MessageOptionsArgTypes, messageOptions } from './send.js';

export const statusCommand: CommandModuleWithContext<
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
  handler: async ({ context, origin, destination, id, relay, dispatchTx }) => {
    await checkMessageStatus({
      context,
      dispatchTx,
      messageId: id,
      destination,
      origin,
      selfRelay: relay,
    });
    process.exit(0);
  },
};
