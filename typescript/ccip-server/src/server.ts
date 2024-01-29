// import { SuccinctProverService } from './services/SuccinctProverService';
import { Server } from '@chainlink/ccip-read-server';
import dotenvFlow from 'dotenv-flow';

dotenvFlow.config();

// const RPC_ADDRESS= process.env.RPC_ADDRESS as string;
// const LIGHT_CLIENT_ADDR = process.env.LIGHT_CLIENT_ADDR  as string;
// const STEP_FN_ID = process.env.STEP_FN_ID  as string;
// const CHAIN_ID= process.env.CHAIN_ID  as string;
// const SUCCINCT_PLATFORM_URL= process.env.SUCCINCT_PLATFORM_URL  as string;
// const SUCCINCT_API_KEY = process.env.SUCCINCT_API_KEY  as string;

// Contract callback function
// const succinctProverService = new SuccinctProverService(RPC_ADDRESS, LIGHT_CLIENT_ADDR, STEP_FN_ID, CHAIN_ID, SUCCINCT_PLATFORM_URL, SUCCINCT_API_KEY);
const abi = [
  'function getSignedBalance(address addr) public view returns(uint256 balance, bytes memory sig)',
];

const server = new Server();
server.add(abi, [
  {
    type: 'getSignedBalance',
    func: async (args) => {
      console.log(args);
      // const stateProofs = await succinctProverService.getProofs();
      return [];
    },
  },
]);
const app = server.makeApp('');
app.listen(3001);
