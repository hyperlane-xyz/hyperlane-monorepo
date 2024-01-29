import { Server } from '@chainlink/ccip-read-server';
import dotenvFlow from 'dotenv-flow';

import { SuccinctProverServiceAbi } from './abis/SuccinctProverServiceAbi';
import * as config from './config';
import { SuccinctProverService } from './services/SuccinctProverService';

dotenvFlow.config();

const succinctProverService = new SuccinctProverService(
  config.RPC_ADDRESS,
  config.LIGHT_CLIENT_ADDR,
  config.STEP_FN_ID,
  config.CHAIN_ID,
  config.SUCCINCT_PLATFORM_URL,
  config.SUCCINCT_API_KEY,
);

const server = new Server();
server.add(SuccinctProverServiceAbi, [
  {
    type: 'getProofs',
    func: succinctProverService.getProofs,
  },
]);
const app = server.makeApp(config.SERVER_URL_PREFIX);
app.listen(config.SERVER_PORT, () =>
  console.log(`Listening on port ${config.SERVER_PORT}`),
);
