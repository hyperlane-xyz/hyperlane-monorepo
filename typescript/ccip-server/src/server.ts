import { Server } from '@chainlink/ccip-read-server';

import { CCTPServiceAbi } from './abis/CCTPServiceAbi';
import { ProofsServiceAbi } from './abis/ProofsServiceAbi';
import * as config from './config';
import { CCTPService } from './services/CCTPService';
// import { OPStackServiceAbi } from './abis/OPStackServiceAbi';
// import { OPStackService } from './services/OPStackService';
import { ProofsService } from './services/ProofsService';

// Initialize Services
const proofsService = new ProofsService(
  {
    lightClientAddress: config.LIGHT_CLIENT_ADDR,
    stepFunctionId: config.STEP_FN_ID,
    platformUrl: config.SUCCINCT_PLATFORM_URL,
    apiKey: config.SUCCINCT_API_KEY,
  },
  { url: config.RPC_ADDRESS, chainId: config.CHAIN_ID },
  { url: `${config.SERVER_URL_PREFIX}:${config.SERVER_PORT}` },
);

// const opStackService = new OPStackService(
//   { url: config.HYPERLANE_EXPLORER_API },
//   { url: config.RPC_ADDRESS, chainId: config.CHAIN_ID },
//   { url: config.L2_RPC_ADDRESS, chainId: config.L2_CHAIN_ID },
//   {
//     l1: {
//       AddressManager: config.L1_ADDRESS_MANAGER,
//       L1CrossDomainMessenger: config.L1_CROSS_DOMAIN_MESSENGER,
//       L1StandardBridge: config.L1_STANDARD_BRIDGE,
//       StateCommitmentChain: config.L1_STATE_COMMITMENT_CHAIN,
//       CanonicalTransactionChain: config.L1_CANONICAL_TRANSACTION_CHAIN,
//       BondManager: config.L1_BOND_MANAGER,
//       OptimismPortal: config.L1_OPTIMISM_PORTAL,
//       L2OutputOracle: config.L2_OUTPUT_ORACLE,
//     },
//   },
// );

const cctpService = new CCTPService(
  { url: config.HYPERLANE_EXPLORER_API },
  { url: config.CCTP_ATTESTATION_API },
  { url: config.RPC_ADDRESS, chainId: config.CHAIN_ID },
);

// Initialize Server and add Service handlers
const server = new Server();

server.add(ProofsServiceAbi, [
  { type: 'getProofs', func: proofsService.getProofs.bind(this) },
]);

// server.add(OPStackServiceAbi, [
//   {
//     type: 'getWithdrawalProof',
//     func: opStackService.getWithdrawalProof.bind(opStackService),
//   },
// ]);

// server.add(OPStackServiceAbi, [
//   {
//     type: 'getFinalizeWithdrawalTx',
//     func: opStackService.getFinalizeWithdrawalTx.bind(opStackService),
//   },
// ]);

server.add(CCTPServiceAbi, [
  {
    type: 'getCCTPAttestation',
    func: cctpService.getCCTPAttestation.bind(cctpService),
  },
]);

// Start Server
const app = server.makeApp(config.SERVER_URL_PREFIX);
app.listen(parseInt(config.SERVER_PORT), '0.0.0.0', () =>
  console.log(`Listening on port ${config.SERVER_PORT}`),
);
