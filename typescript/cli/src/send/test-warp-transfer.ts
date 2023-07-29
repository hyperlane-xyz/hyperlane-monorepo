// import assert from 'assert';
// import { BigNumber, ContractReceipt, ethers } from 'ethers';
// import yargs from 'yargs';

// import {
//   ERC20__factory,
//   HypERC20,
//   HypERC20App,
//   HypERC20Collateral,
//   HypERC20Collateral__factory,
//   HypERC20__factory,
//   HypNative,
//   HypNative__factory,
//   TokenType,
// } from '@hyperlane-xyz/hyperlane-token';
// import {
//   ChainMap,
//   HyperlaneCore,
//   MultiProvider,
//   objMap,
//   objMerge,
// } from '@hyperlane-xyz/sdk';
// import { utils } from '@hyperlane-xyz/utils';

// import {
//   artifactsAddressesMap,
//   assertBalances,
//   assertBytes20,
//   assertBytes32,
//   getMultiProvider,
//   sdkContractAddressesMap,
// } from '../config.js';
// import { createLogger } from '../logger.js';
// import { readJson } from '../utils/files.js';
// import { WarpRouteArtifacts } from '../warp/WarpRouteDeployer.js';

// import { run } from './run.js';

// const logger = createLogger('WarpTransferTest');
// const error = createLogger('WarpTransferTest', true);

// const mergedContractAddresses = objMerge(
//   sdkContractAddressesMap,
//   artifactsAddressesMap(),
// );

// function getArgs(multiProvider: MultiProvider) {
//   // Only accept chains for which we have both a connection and contract addresses
//   const { intersection } = multiProvider.intersect(
//     Object.keys(mergedContractAddresses),
//   );
//   return yargs(process.argv.slice(2))
//     .describe('origin', 'chain to send tokens from')
//     .choices('origin', intersection)
//     .demandOption('origin')
//     .string('origin')
//     .describe('destination', 'chain to send tokens to')
//     .choices('destination', intersection)
//     .demandOption('destination')
//     .string('destination')
//     .describe('wei', 'amount in wei to send')
//     .demandOption('wei')
//     .number('wei')
//     .describe('key', 'hexadecimal private key for transaction signing')
//     .string('key')
//     .coerce('key', assertBytes32)
//     .demandOption('key')
//     .describe('recipient', 'token recipient address')
//     .string('recipient')
//     .coerce('recipient', assertBytes20)
//     .demandOption('recipient')
//     .describe('timeout', 'timeout in seconds')
//     .number('timeout')
//     .default('timeout', 10 * 60)
//     .middleware(assertBalances(multiProvider, (argv) => [argv.origin])).argv;
// }

// function hypErc20FromAddressesMap(
//   artifactsMap: ChainMap<WarpRouteArtifacts>,
//   multiProvider: MultiProvider,
// ): HypERC20App {
//   const contractsMap = objMap(artifactsMap, (chain, artifacts) => {
//     const signer = multiProvider.getSigner(chain);
//     switch (artifacts.tokenType) {
//       case TokenType.collateral: {
//         const router = HypERC20Collateral__factory.connect(
//           artifacts.router,
//           signer,
//         );
//         return { router };
//       }
//       case TokenType.native: {
//         const router = HypNative__factory.connect(artifacts.router, signer);
//         return { router };
//       }
//       case TokenType.synthetic: {
//         const router = HypERC20__factory.connect(artifacts.router, signer);
//         return { router };
//       }
//       default: {
//         throw new Error('Unsupported token type');
//       }
//     }
//   });
//   return new HypERC20App(contractsMap, multiProvider);
// }

// run('Warp transfer test', async () => {
//   let timedOut = false;
//   const multiProvider = getMultiProvider();
//   const { recipient, origin, destination, wei, key, timeout } = await getArgs(
//     multiProvider,
//   );
//   const timeoutId = setTimeout(() => {
//     timedOut = true;
//   }, timeout * 1000);
//   const signer = new ethers.Wallet(key);
//   multiProvider.setSharedSigner(signer);
//   const artifacts: ChainMap<WarpRouteArtifacts> = readJson(
//     './artifacts/warp-token-addresses.json',
//   );
//   const app = hypErc20FromAddressesMap(artifacts, multiProvider);

//   const getDestinationBalance = async (): Promise<BigNumber> => {
//     switch (artifacts[destination].tokenType) {
//       case TokenType.collateral: {
//         const router = app.getContracts(destination)
//           .router as HypERC20Collateral;
//         const tokenAddress = await router.wrappedToken();
//         const token = ERC20__factory.connect(tokenAddress, signer);
//         return token.balanceOf(recipient);
//       }
//       case TokenType.native: {
//         return multiProvider.getProvider(destination).getBalance(recipient);
//       }
//       case TokenType.synthetic: {
//         const router = app.getContracts(destination).router as HypERC20;
//         return router.balanceOf(recipient);
//       }
//       default: {
//         throw new Error('Unsupported collateral type');
//       }
//     }
//   };
//   const balanceBefore = await getDestinationBalance();

//   const core = HyperlaneCore.fromAddressesMap(
//     mergedContractAddresses,
//     multiProvider,
//   );

//   let receipt: ContractReceipt;
//   switch (artifacts[origin].tokenType) {
//     case TokenType.collateral: {
//       const router = app.getContracts(origin).router as HypERC20Collateral;
//       const tokenAddress = await router.wrappedToken();
//       const token = ERC20__factory.connect(tokenAddress, signer);
//       const approval = await token.allowance(
//         await signer.getAddress(),
//         router.address,
//       );
//       if (approval.lt(wei)) {
//         await token.approve(router.address, wei);
//       }
//       receipt = await app.transfer(
//         origin,
//         destination,
//         utils.addressToBytes32(recipient),
//         wei,
//       );
//       break;
//     }
//     case TokenType.native: {
//       const destinationDomain = multiProvider.getDomainId(destination);
//       const router = app.getContracts(origin).router as HypNative;
//       const gasPayment = await router.quoteGasPayment(destinationDomain);
//       const value = gasPayment.add(wei);
//       const tx = await router.transferRemote(
//         destinationDomain,
//         utils.addressToBytes32(recipient),
//         wei,
//         { value },
//       );
//       receipt = await tx.wait();
//       break;
//     }
//     case TokenType.synthetic: {
//       receipt = await app.transfer(
//         origin,
//         destination,
//         utils.addressToBytes32(recipient),
//         wei,
//       );
//       break;
//     }
//     default: {
//       throw new Error('Unsupported token type');
//     }
//   }

//   const messages = await core.getDispatchedMessages(receipt);
//   const message = messages[0];
//   const msgDestination = multiProvider.getChainName(message.parsed.destination);
//   assert(destination === msgDestination);

//   while (
//     !(await core.getContracts(destination).mailbox.delivered(message.id)) &&
//     !timedOut
//   ) {
//     logger(`Waiting for message delivery on destination chain`);
//     await utils.sleep(1000);
//   }

//   if (!timedOut) {
//     logger(`Message delivered on destination chain!`);
//     const balanceAfter = await getDestinationBalance();
//     if (!balanceAfter.gt(balanceBefore)) {
//       throw new Error('Destination chain balance did not increase');
//     }
//     logger(`Confirmed balance increase`);
//   }

//   clearTimeout(timeoutId);
//   if (timedOut) {
//     error('Timed out waiting for messages to be delivered');
//     process.exit(1);
//   }
// });
