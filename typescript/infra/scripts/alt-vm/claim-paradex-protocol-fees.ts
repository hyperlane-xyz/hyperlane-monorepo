import { Account, Contract } from 'starknet';

import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { AgentGCPKey } from '../../src/agents/gcp.js';
import { Role } from '../../src/roles.js';
import { getArgs } from '../agent-utils.js';
import { defaultStarknetJsProviderBuilder } from '@hyperlane-xyz/sdk/providers/providerBuilders';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({ module: 'claim-paradex-protocol-fees' });

const DEFAULT_PROTOCOL_FEE_ADDRESS =
  '0x025fd2fb21f47a041e6a25d16928684414db50ebddef52b1286d56318fa574e8';

const PARADEX_USDC =
  '0x7348407ebad690fec0cc8597e87dc16ef7b269a655ff72587dafff83d462be2';

// Paradex DEX contract
const DEX_ADDRESS =
  '0x03ca9388f8d4e04adecbd7b06b9b24a33030a593522248a7bddd87afc0b61a0c';

const COLLECT_PROTOCOL_FEES_ABI = [
  {
    type: 'interface',
    name: 'IProtocolFee',
    items: [
      {
        type: 'function',
        name: 'collect_protocol_fees',
        inputs: [],
        outputs: [],
        state_mutability: 'external',
      },
    ],
  },
];

const ERC_20_ABI = [
  {
    type: 'interface',
    name: 'IERC20',
    items: [
      {
        type: 'function',
        name: 'balanceOf',
        inputs: [
          {
            name: 'account',
            type: 'core::starknet::contract_address::ContractAddress',
          },
        ],
        outputs: [{ type: 'core::integer::u256' }],
        state_mutability: 'view',
      },
    ],
  },
  {
    name: 'approve',
    type: 'function',
    inputs: [
      {
        name: 'spender',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      { name: 'amount', type: 'core::integer::u256' },
    ],
    outputs: [],
  },
];

const DEX_CONTRACT_ABI = [
  {
    name: 'deposit_on_behalf_of',
    type: 'function',
    inputs: [
      {
        name: 'recipient',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      {
        name: 'token_address',
        type: 'core::starknet::contract_address::ContractAddress',
      },
      { name: 'amount', type: 'core::felt252' },
    ],
    outputs: [],
  },
];

async function main() {
  const {
    environment,
    address: recipientAddress,
    protocolFeeAddress,
    amount,
  } = await getArgs()
    .option('address', {
      type: 'string',
      describe:
        'Recipient of the funds on the paradex dex. This is your paradex address, NOT your ethereum address',
      demandOption: true,
    })
    .option('protocol-fee-address', {
      type: 'string',
      describe: 'Paradex protocol fee contract address',
      default: DEFAULT_PROTOCOL_FEE_ADDRESS,
    })
    .option('amount', {
      type: 'string',
      describe:
        'USDC amount to send (smallest unit). If omitted, sends full balance',
    }).argv;

  // Fetch deployer key from GCP
  logger.info('Fetching deployer key from GCP...');
  const key = new AgentGCPKey(
    environment,
    Contexts.Hyperlane,
    Role.Deployer,
    'paradex',
  );
  await key.fetch();

  const envConfig = getEnvironmentConfig(environment);
  const registry = await envConfig.getRegistry(true);

  const privateKey = key.privateKeyForProtocol(ProtocolType.Starknet);
  const address = key.addressForProtocol(ProtocolType.Starknet);
  assert(address, 'Failed to resolve Starknet address from GCP key');

  // Get Paradex chain metadata
  const paradexMetadata = await registry.getChainMetadata('paradex');

  if (!paradexMetadata) {
    throw new Error('Paradex metadata not found in registry');
  }

  assert(paradexMetadata.rpcUrls.length > 0, 'No RPC URLs found for paradex');
  const rpcUrl = paradexMetadata.rpcUrls[0].http;

  // Connect to Paradex via raw starknet.js for the claim step
  const provider = defaultStarknetJsProviderBuilder(
    [{ http: rpcUrl }],
    paradexMetadata.chainId,
  ).provider;
  const account = new Account(provider, address, privateKey);

  const usdcContract = new Contract(ERC_20_ABI, PARADEX_USDC, provider);

  const prevBalance = await usdcContract.balanceOf(address);

  // Claim protocol fees
  logger.info(`Claiming protocol fees from contract ${protocolFeeAddress}...`);
  const feeContract = new Contract(
    COLLECT_PROTOCOL_FEES_ABI,
    protocolFeeAddress,
    provider,
  );
  feeContract.connect(account);

  // This tx will fail if there are no fees to claim
  const { transaction_hash: claimTxHash } =
    await feeContract.collect_protocol_fees();
  logger.info(`Claim tx submitted: ${claimTxHash} Waiting for confirmation...`);
  await provider.waitForTransaction(claimTxHash);
  logger.info('Protocol fees claimed successfully');

  // Check USDC balance
  const balance = await usdcContract.balanceOf(address);

  const difference = balance - prevBalance;
  // This is very buggy right now and might not be true
  logger.info(`Claimed USDC amount: ${difference}`);

  const sendAmount = amount ?? balance.toString();

  if (sendAmount === '0') {
    logger.info('No USDC to send, exiting');
    return;
  }

  // First call deposit on behalf and then execute remote transfer
  // We will have to approve first, in order to call deposit on behalf
  logger.info(
    `Approving ${+sendAmount.toString() / 1e6} USDC for deposit on behalf...`,
  );
  usdcContract.connect(account);
  const { transaction_hash: approveTxHash } = await usdcContract.approve(
    DEX_ADDRESS,
    sendAmount,
  );
  logger.info(
    `Approve transaction submitted, hash: ${approveTxHash} Waiting for confirmation...`,
  );
  await provider.waitForTransaction(approveTxHash);
  logger.info(
    `USDC approved for deposit on behalf, transaction hash: ${approveTxHash}`,
  );

  // Now deposit on behalf of the
  const dexContract = new Contract(DEX_CONTRACT_ABI, DEX_ADDRESS, provider);
  dexContract.connect(account);
  logger.info(
    `Depositing on behalf of recipient ${recipientAddress} to Paradex DEX...`,
  );
  const { transaction_hash } = await dexContract.deposit_on_behalf_of(
    recipientAddress,
    PARADEX_USDC,
    +sendAmount! * 1e2, // Paradex USDC has 8 decimals, while we are passing in an amount with 6 decimals, so we need to multiply by 1e2
  );
  logger.info(
    `Deposit on behalf transaction submitted, hash: ${transaction_hash} Waiting for confirmation...`,
  );

  await provider.waitForTransaction(transaction_hash);
  logger.info(
    `Deposit on behalf successful, transaction hash: ${transaction_hash}`,
  );
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
