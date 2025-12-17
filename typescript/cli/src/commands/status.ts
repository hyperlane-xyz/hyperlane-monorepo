import {
  CommandContext,
  CommandModuleWithContext,
  WriteCommandContext,
} from '../context/types.js';
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
  handler: async ({ context, origin, id, relay, dispatchTx }) => {
    // When --relay is passed, signers are initialized and context is a WriteCommandContext
    // Otherwise it's just a CommandContext (read-only operations)
    await checkMessageStatus({
      context: context as CommandContext | WriteCommandContext,
      dispatchTx,
      messageId: id,
      origin,
      selfRelay: relay,
    });
    process.exit(0);
  },
};
