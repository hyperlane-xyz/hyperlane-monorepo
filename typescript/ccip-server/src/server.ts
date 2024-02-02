import { Server } from '@chainlink/ccip-read-server';

import { ProofsServiceAbi } from './abis/ProofsServiceAbi';
import * as config from './config';
import { ProofsService } from './services/ProofsService';

const proofsService = new ProofsService(
  config.LIGHT_CLIENT_ADDR,
  config.RPC_ADDRESS,
  config.STEP_FN_ID,
  config.CHAIN_ID,
  config.SUCCINCT_PLATFORM_URL,
  config.SUCCINCT_API_KEY,
);

const server = new Server();
server.add(ProofsServiceAbi, [
  {
    type: 'getProofs',
    func: proofsService.getProofs,
  },
]);

const app = server.makeApp(config.SERVER_URL_PREFIX);
app.listen(config.SERVER_PORT, () =>
  console.log(`Listening on port ${config.SERVER_PORT}`),
);
