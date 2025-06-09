import { Account, Provider, shortString } from 'starknet';

// import yargs from 'yargs';
// import { hideBin } from 'yargs/helpers';

import { ChainName, getStarknetContract } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getChain } from '../../config/registry.js';

import staked from './staked.json' with { type: 'json' };

async function main() {
  //   const argv = await yargs(hideBin(process.argv))
  //     .option('chain', {
  //       describe: 'Starknet chain name (e.g. starknetsepolia)',
  //       type: 'string',
  //       demandOption: true,
  //     })
  //     .option('private-key', {
  //       describe: 'Private key of the announcer account',
  //       type: 'string',
  //       demandOption: true,
  //     }).argv;

  const chainName: ChainName = 'starknet';
  const chainConfig = getChain(chainName);
  if (chainConfig.protocol !== 'starknet') {
    throw new Error(`Chain ${chainName} is not a StarkNet chain`);
  }

  const rpcUrl = chainConfig.rpcUrls[0]?.http;
  if (!rpcUrl) {
    throw new Error(`No RPC URL found for chain ${chainName}`);
  }

  const provider = new Provider({ nodeUrl: rpcUrl });

  // This is a common ArgentX account address, you may need to change this
  // for other account types
  const accountAddress =
    '0x06aE465e0c05735820a75500c40CB4dAbBe46eBF1F1665f9ba3f9a7Dcc78a6D1';
  const account = new Account(provider, accountAddress, '<PRIVATE_KEY>', '1');

  const data = staked;

  const { validator, storage_location } = data.value;
  const signature = data.serialized_signature;

  const contract = getStarknetContract(
    'validator_announce',
    '0x03bcb0295d31170c5d51f6edce35d5802ce62527e0f15bd8b9f1b979db32e53a',
    account,
  );

  const storageLocationFelts = [shortString.encodeShortString('xx')];

  rootLogger.info('Announcing validator...');
  rootLogger.info(`  Validator: ${validator}`);
  rootLogger.info(`  Storage Location: ${storage_location}`);
  rootLogger.info(
    `  Storage Location (felts): ${JSON.stringify(storageLocationFelts)}`,
  );
  rootLogger.info(`  Signature: ${signature}`);
  rootLogger.info(`  Account: ${account.address}`);

  // Convert signature to Bytes struct format
  const signatureWithout0x = signature.startsWith('0x')
    ? signature.slice(2)
    : signature;
  const signatureFelts = [];
  for (let i = 0; i < signatureWithout0x.length; i += 62) {
    const chunk = signatureWithout0x.slice(i, i + 62);
    signatureFelts.push('0x' + chunk);
  }

  const lastFelt = signatureFelts.pop()!;
  const pendingWordLen = (signatureWithout0x.length % 62) / 2; // Convert hex chars to bytes

  const call = await contract.invoke('announce', [
    validator,
    storageLocationFelts,
    {
      data: signatureFelts,
      pending_word: lastFelt,
      pending_word_len: pendingWordLen,
      size: signatureWithout0x.length / 2,
    },
  ]);

  rootLogger.info('Waiting for transaction...');
  const result = await provider.waitForTransaction(call.transaction_hash);

  rootLogger.info('Transaction confirmed:');
  rootLogger.info(`  Transaction hash: ${call.transaction_hash}`);
  if ('execution_status' in result) {
    rootLogger.info(`  Status: ${result.execution_status}`);
  }
}

main().catch((err) => {
  rootLogger.error(err);
  process.exit(1);
});
