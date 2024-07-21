import { Server } from '@chainlink/ccip-read-server';
import { log } from 'console';

import { ProofsServiceAbi } from './abis/ProofsServiceAbi';
import * as config from './config';
import { ProofsService } from './services/ProofsService';

const server = new Server();
server.add(ProofsServiceAbi, [
  {
    type: 'getProofs',
    func: async ([target, storageKey, messageId]) => {
      const proofsService = new ProofsService(
        config.RPC_ADDRESS,
        config.HYPERLANE_API_URL,
      );
      return proofsService.getProofs(target, storageKey, messageId);
    },
  },
]);

const app = server.makeApp(config.SERVER_URL_PREFIX);
app.listen(config.SERVER_PORT, () =>
  log(`Listening on port ${config.SERVER_PORT}`),
);
