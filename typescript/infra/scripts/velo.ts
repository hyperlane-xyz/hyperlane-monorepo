import { utils } from 'ethers';

import {
  TestRecipient__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import {
  HyperlaneRelayer,
  InterchainAccount,
  commitmentFromIcaCalls,
  shareCallsWithPrivateRelayer,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { getEnvAddresses } from '../config/registry.js';
import { Role } from '../src/roles.js';

import { Modules, getAddresses, getArgs, withContext } from './agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from './core-utils.js';

async function main() {
  const {
    context = Contexts.Hyperlane,
    environment,
    testmessage,
    origin: originRaw,
    destination: destinationRaw,
  } = await withContext(
    getArgs()
      .describe('testmessage', 'the message to send')
      .describe('origin', 'the origin chain')
      .describe('destination', 'the destination chain'),
  ).argv;
  const envConfig = getEnvironmentConfig(environment);
  let multiProvider = await envConfig.getMultiProvider(
    context,
    Role.Deployer,
    true,
  );
  const { core } = await getHyperlaneCore(environment, multiProvider);
  const addresses = getAddresses(environment, Modules.INTERCHAIN_ACCOUNTS);
  const app = InterchainAccount.fromAddressesMap(addresses, multiProvider);
  //   assert that origin is in the supported chains
  const origin = originRaw as keyof typeof addresses;
  const destination = destinationRaw as keyof typeof addresses;

  const testRecipient = getEnvAddresses(environment)[destination].testRecipient;

  const destinationDomainId = multiProvider.getDomainId(destination);
  //   deploy trusted relayer ism to avoid having to run a relayer locally
  const ism = await new TrustedRelayerIsm__factory(
    multiProvider.getSigner('test2'),
  ).deploy(
    core.getAddresses('test2').mailbox,
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  );
  await core.contractsMap.test2.mailbox.setDefaultIsm(ism.address);
  const testReipientContract = TestRecipient__factory.connect(
    testRecipient,
    multiProvider.getSigner(destination),
  );

  console.log('Start preparing the call');

  const relayer = new HyperlaneRelayer({ core, caching: false });
  const calls = [
    {
      to: testRecipient,
      data: TestRecipient__factory.createInterface().encodeFunctionData(
        // @ts-ignore
        'fooBar',
        [1, testmessage],
      ),
    },
  ];

  const interchainAccountRouter =
    app.contractsMap[origin].interchainAccountRouter;

  const quote = await interchainAccountRouter.quoteGasForCommitReveal(
    destinationDomainId,
    100000,
  );
  //   generate random salt
  const salt = utils.keccak256(utils.randomBytes(32));
  const commitment = commitmentFromIcaCalls(calls, salt);
  const originTx = await interchainAccountRouter[
    'callRemoteCommitReveal(uint32,bytes32,uint256)'
  ](destinationDomainId, commitment, 100000, { value: quote });

  const receipt = await originTx.wait();

  // Post the committed calls to the CCIP-read server using fetch

  const messageId = core.getDispatchedMessages(receipt)[0].id;
  const relayerAddress = await multiProvider
    .getSigner(destination)
    .getAddress();
  const serverUrl = 'http://localhost:3000/callCommitments/calls';
  console.log(
    `Commitment messageId ${messageId} in tx ${receipt.transactionHash}`,
  );
  try {
    await shareCallsWithPrivateRelayer(serverUrl, {
      calls,
      salt,
      relayers: [relayerAddress],
      commitmentDispatchTx: receipt.transactionHash,

      originDomain: multiProvider.getDomainId(origin),
    });
    console.log('Posted calls to server');
  } catch (err) {
    console.error('Error posting calls to server:', err);
    throw err;
  }

  const revealMessageId = core.getDispatchedMessages(receipt)[1].id;
  console.log(
    `Relay once commitment is processed with ${revealMessageId} in tx ${receipt.transactionHash}`,
  );

  //   first is just the commitment
  await relayer.relayMessage(receipt, 0);

  // the result shouldn't yet change after the commitment
  //   const result = await testReipientContract.lastCallMessage();
  //   console.log("result shouldn't yet change", result);

  //   Now we relay the reveal (reanble once the ISM blocks on the commitment being relayed)
  await relayer.relayMessage(receipt, 1);
  const result = await testReipientContract.lastCallMessage();
  assert(
    testmessage === (await testReipientContract.lastCallMessage()),
    'Result should change after the reveal ' + result,
  );
}

main().then(console.log).catch(console.error);
