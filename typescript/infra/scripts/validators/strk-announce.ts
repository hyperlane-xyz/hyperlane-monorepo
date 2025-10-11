import { Account, CallData, ETransactionVersion3 } from 'starknet';
import yargs from 'yargs';

import { getValidatorFromStorageLocation } from '@hyperlane-xyz/sdk';
import { hexOrBase58ToHex } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { AgentGCPKey } from '../../src/agents/gcp.js';
import { Role } from '../../src/roles.js';
import { getEnvironmentConfig } from '../core-utils.js';

// Convert storage location to felt252 array (31 bytes max per felt)
function stringToFeltArray(str: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += 31) {
    const chunk = str.slice(i, i + 31);
    const hex = '0x' + Buffer.from(chunk).toString('hex');
    chunks.push(hex);
  }
  return chunks;
}

// Convert signature to proper Starknet Bytes format
function signatureToBytes(sig: string): any[] {
  const sigHex = sig.slice(2);
  const sigBytes = Buffer.from(sigHex, 'hex');

  // Bytes format: [size, ...packed_u128_chunks]
  // Each u128 chunk contains 16 bytes, padded if necessary
  const size = sigBytes.length;
  const padding = (16 - (size % 16)) % 16;
  const paddedBytes = new Uint8Array([...sigBytes, ...new Uint8Array(padding)]);

  const chunks: string[] = [];
  for (let i = 0; i < paddedBytes.length; i += 16) {
    const chunk = new Uint8Array(paddedBytes.slice(i, i + 16));
    const u128Value = BigInt('0x' + Buffer.from(chunk).toString('hex'));
    chunks.push(u128Value.toString());
  }

  return [size.toString(), ...chunks];
}

async function announceValidator() {
  const { chain, location } = await yargs(process.argv.slice(2))
    .describe('chain', 'chain on which to register')
    .choices('chain', ['starknet', 'paradex'])
    .demandOption('chain')
    .describe(
      'location',
      'location, e.g. s3://hyperlane-testnet4-sepolia-validator-0/us-east-1',
    )
    .string('location')
    .demandOption('location').argv;

  const envConfig = getEnvironmentConfig('mainnet3');
  const registry = await envConfig.getRegistry();
  const addresses = await registry.getChainAddresses(chain);
  if (!addresses) {
    throw new Error(`No addresses found for chain ${chain}`);
  }

  const mpp = await envConfig.getMultiProtocolProvider();
  const provider = mpp.getStarknetProvider(chain);

  const validator = await getValidatorFromStorageLocation(location);
  const { value: announcement, serialized_signature } =
    await validator.getSignedAnnouncement();
  console.log('Announcement:', announcement);
  console.log('Serialized signature:', serialized_signature);

  // Prepare calldata manually
  const storageChunks = stringToFeltArray(announcement.storage_location);
  const sigBytes = signatureToBytes(serialized_signature);

  console.log('Storage chunks:', storageChunks);
  console.log('Signature bytes structure:');
  console.log('  Size (bytes):', sigBytes[0]);
  console.log('  Packed u128 chunks:', sigBytes.slice(1));

  // Use CallData to properly encode the parameters
  const calldata = CallData.compile({
    _validator: announcement.validator,
    _storage_location: storageChunks,
    _signature: {
      size: parseInt(sigBytes[0]),
      data: sigBytes.slice(1),
    },
  });

  console.log('\nFull calldata:', calldata);

  // First, simulate the call
  console.log('\nSimulating call...');
  try {
    const result = await provider.callContract({
      contractAddress: addresses.validatorAnnounce,
      entrypoint: 'announce',
      calldata: calldata,
    });
    console.log('✅ Simulation successful:', result);
  } catch (error: any) {
    console.error('❌ Simulation failed:');
    if (error.baseError?.data?.revert_error) {
      const hex = error.baseError.data.revert_error;
      const ascii = Buffer.from(hex.slice(2), 'hex').toString('ascii');
      console.error('  Error message:', ascii);
    }
    console.error(error);
    return;
  }

  // Then execute the transaction
  console.log('\nExecuting transaction...');
  try {
    // Create account from private key
    const deployer = new AgentGCPKey(
      'mainnet3',
      Contexts.Hyperlane,
      Role.Deployer,
      chain,
    );
    await deployer.fetch();
    const account = new Account(
      provider,
      hexOrBase58ToHex(deployer.address),
      hexOrBase58ToHex(deployer.privateKey),
    );

    // Execute the transaction with resource bounds
    const result = await account.execute(
      {
        contractAddress: addresses.validatorAnnounce,
        entrypoint: 'announce',
        calldata: calldata,
      },
      {
        resourceBounds: {
          l1_gas: {
            max_amount: '0x100000', // 1048576 - much higher for complex computation
            max_price_per_unit: '0x3b9aca00', // 1 gwei in wei (1000000000)
          },
          l2_gas: {
            max_amount: '0x1000000', // 16777216 - much higher for complex computation
            max_price_per_unit: '0x3b9aca00', // 1 gwei in wei (1000000000)
          },
          l1_data_gas: {
            max_amount: '0x10000', // 65536 - higher for data processing
            max_price_per_unit: '0x3b9aca00', // 1 gwei in wei (1000000000)
          },
        },
      },
    );

    console.log('✅ Transaction submitted:', result.transaction_hash);
    console.log('Waiting for confirmation...');

    // Wait for transaction to be confirmed
    await provider.waitForTransaction(result.transaction_hash);
    console.log('✅ Transaction confirmed!');
  } catch (error: any) {
    console.error('❌ Transaction failed:');
    console.error(error);
    return;
  }
}

announceValidator().catch(console.error);
