import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet, ethers } from 'ethers';
import { base58, formatUnits, parseUnits } from 'ethers/lib/utils.js';
import { Account as StarknetAccount } from 'starknet';
import { format } from 'util';

import {
  ChainName,
  MultiProtocolProvider,
  MultiProvider,
  ProtocolTypedTransaction,
  TOKEN_STANDARD_TO_PROVIDER_TYPE,
  Token,
  TransferParams,
  TypedTransaction,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  rootLogger,
  strip0x,
} from '@hyperlane-xyz/utils';

import {
  CosmJsNativeTransaction,
  EthersV5Transaction,
  SolanaWeb3Transaction,
  StarknetJsTransaction,
} from '../../../sdk/dist/providers/ProviderType.js';
import { Contexts } from '../../config/contexts.js';
import { getDeployerKey } from '../../src/agents/key-utils.js';
import { CloudAgentKey } from '../../src/agents/keys.js';
import { EnvironmentConfig } from '../../src/config/environment.js';
import { assertChain } from '../../src/utils/utils.js';
import { getAgentConfig, getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({ module: 'fund-hot-wallet' });

async function main() {
  const argv = await getArgs()
    .string('recipient')
    .alias('r', 'recipient')
    .describe('recipient', 'The address to fund')
    .demandOption('recipient')

    .string('amount')
    .alias('a', 'amount')
    .describe(
      'amount',
      'Amount to send (in token units, e.g., "1.5" for 1.5 ETH)',
    )
    .demandOption('amount')

    .string('chain')
    .alias('c', 'chain')
    .describe('chain', 'Chain name to send funds on')
    .demandOption('chain')
    .coerce('chain', assertChain)

    .boolean('dry-run')
    .describe('dry-run', 'Simulate the transaction without sending')
    .default('dry-run', false).argv;

  const config = getEnvironmentConfig(argv.environment);
  const { recipient, amount, chain, dryRun } = argv;

  logger.info(
    {
      recipient,
      amount,
      chain,
      dryRun,
    },
    'Starting funding operation',
  );

  try {
    await fundAccount({
      config,
      chainName: chain!,
      recipientAddress: recipient,
      amount,
      dryRun,
    });

    logger.info('Funding operation completed successfully');
  } catch (error) {
    logger.error(
      {
        error: format(error),
        chain,
        recipient,
        amount,
      },
      'Funding operation failed',
    );
    process.exit(1);
  }
}

interface FundingParams {
  config: EnvironmentConfig;
  chainName: ChainName;
  recipientAddress: Address;
  amount: string;
  dryRun: boolean;
}

async function fundAccount({
  config,
  chainName,
  recipientAddress,
  amount,
  dryRun,
}: FundingParams): Promise<void> {
  const multiProtocolProvider = await config.getMultiProtocolProvider();

  const chainMetadata = multiProtocolProvider.getChainMetadata(chainName);
  const protocol = chainMetadata.protocol;

  // Create token instance
  logger.info({ chainName, protocol }, 'Preparing token adapter');

  const token = Token.FromChainMetadataNativeToken(chainMetadata);
  const adapter = token.getAdapter(multiProtocolProvider);

  // Get signer
  logger.info({ chainName, protocol }, 'Retrieving signer info');

  const agentConfig = getAgentConfig(Contexts.Hyperlane, config.environment);
  const privateKeyAgent = getDeployerKey(agentConfig, chainName);
  const signer = await getSignerForChain(
    chainName,
    privateKeyAgent,
    multiProtocolProvider,
  );

  logger.info({ chainName, protocol }, 'Performing pre transaction checks');

  // Check balance before transfer
  const fromAddress = await signer.address();
  const currentBalance = await adapter.getBalance(fromAddress);

  logger.info(
    {
      fromAddress,
      currentBalance: currentBalance.toString(),
      symbol: token.symbol,
    },
    'Current sender balance',
  );

  // Convert amount to wei/smallest unit
  const decimals = token.decimals;
  const weiAmount = parseUnits(amount, decimals).toBigInt();

  logger.info(
    {
      amount,
      decimals,
      weiAmount: weiAmount.toString(),
    },
    'Parsed transfer amount',
  );

  // Check if we have sufficient balance
  if (currentBalance < weiAmount) {
    throw new Error(
      `Insufficient balance. Have: ${formatUnits(currentBalance, decimals)} ${token.symbol}, Need: ${amount} ${token.symbol}`,
    );
  }

  // Build transfer parameters based on protocol requirements
  const transferParams: TransferParams = {
    weiAmountOrId: weiAmount,
    recipient: recipientAddress,
    fromAccountOwner: fromAddress,
  };

  logger.info(
    {
      transferParams,
      dryRun,
    },
    'Preparing transfer transaction',
  );

  // Execute the transfer
  const transferTx = await adapter.populateTransferTx(transferParams);

  const protocolTypedTx: TypedTransaction = {
    transaction: transferTx as any,
    type: TOKEN_STANDARD_TO_PROVIDER_TYPE[token.standard] as any,
  };

  console.log(protocolTypedTx);

  if (dryRun || true) {
    logger.info('DRY RUN: Would execute transfer with above parameters');
    return;
  }

  await signer.sendTransaction(protocolTypedTx as any);

  // Verify the transfer
  const newBalance = await adapter.getBalance(fromAddress);
  const recipientBalance = await adapter.getBalance(recipientAddress);

  logger.info(
    {
      senderNewBalance: formatUnits(newBalance, decimals),
      recipientBalance: formatUnits(recipientBalance, decimals),
      symbol: token.symbol,
    },
    'Transfer completed successfully',
  );
}

interface IMultiProtocolSigner<TProtocol extends ProtocolType> {
  address(): Promise<Address>;
  sendTransaction(tx: ProtocolTypedTransaction<TProtocol>): Promise<string>;
}

class SvmMultiprotocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Sealevel>
{
  private readonly signer: Keypair;

  constructor(
    private readonly chainName: ChainName,
    private readonly privateKey: string,
    private readonly multiProtocolProvider: MultiProtocolProvider,
  ) {
    this.signer = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(String(Buffer.from(strip0x(this.privateKey), 'base64'))),
      ),
    );
  }

  async address(): Promise<Address> {
    return this.signer.publicKey.toBase58();
  }

  async sendTransaction(tx: SolanaWeb3Transaction): Promise<string> {
    const svmProvider = this.multiProtocolProvider.getSolanaWeb3Provider(
      this.chainName,
    );

    const txSignature = await sendAndConfirmTransaction(
      svmProvider,
      tx.transaction,
      [this.signer],
    );

    return txSignature;
  }
}

class EvmMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Ethereum>
{
  private readonly multiProvider: MultiProvider;

  constructor(
    private readonly chainName: ChainName,
    privateKey: string,
    multiProtocolProvider: MultiProtocolProvider,
  ) {
    const multiProvider = multiProtocolProvider.toMultiProvider();

    multiProvider.setSigner(this.chainName, new Wallet(privateKey));
    this.multiProvider = multiProvider;
  }

  async address(): Promise<Address> {
    return this.multiProvider.getSignerAddress(this.chainName);
  }

  async sendTransaction(tx: EthersV5Transaction): Promise<string> {
    const res = await this.multiProvider.sendTransaction(
      this.chainName,
      tx.transaction,
    );

    return res.transactionHash;
  }
}

class StarknetMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Starknet>
{
  private readonly signer: StarknetAccount;

  constructor(
    private readonly chainName: ChainName,
    privateKey: string,
    address: string,
    multiProtocolProvider: MultiProtocolProvider,
  ) {
    const provider = multiProtocolProvider.getStarknetProvider(this.chainName);

    this.signer = new StarknetAccount(
      provider,
      // Assumes that both the private key and the related address are base58 encoded
      // in secrets manager
      ethers.utils.hexlify(base58.decode(address)),
      base58.decode(privateKey),
    );
  }

  async address(): Promise<string> {
    return this.signer.address;
  }

  async sendTransaction(tx: StarknetJsTransaction): Promise<string> {
    const { entrypoint, calldata, contractAddress } = tx.transaction;
    assert(entrypoint, 'entrypoint is required for starknet transactions');

    const transaction = await this.signer.execute([
      {
        contractAddress,
        entrypoint,
        calldata,
      },
    ]);

    const transactionReceipt = await this.signer.waitForTransaction(
      transaction.transaction_hash,
    );

    if (transactionReceipt.isReverted()) {
      throw new Error('Transaction failed');
    }

    return transaction.transaction_hash;
  }
}

class CosmosNativeMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.CosmosNative>
{
  constructor(
    private readonly chainName: ChainName,
    private readonly accountAddress: Address,
    private readonly signer: SigningStargateClient,
  ) {}

  static async init(
    chainName: ChainName,
    privateKey: string,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<CosmosNativeMultiProtocolSignerAdapter> {
    const { bech32Prefix, rpcUrls } =
      multiProtocolProvider.getChainMetadata(chainName);

    const [rpc] = rpcUrls;
    assert(bech32Prefix, 'prefix is required for cosmos chains');
    assert(rpc, 'rpc is required for configuring cosmos chains');

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(privateKey, 'hex'),
      bech32Prefix,
    );

    const [account] = await wallet.getAccounts();
    assert(account, 'account not found for cosmos chain');
    const signer = await SigningStargateClient.connectWithSigner(
      rpc.http,
      wallet,
    );

    return new CosmosNativeMultiProtocolSignerAdapter(
      chainName,
      account.address,
      signer,
    );
  }

  async address(): Promise<string> {
    return this.accountAddress;
  }

  async sendTransaction(tx: CosmJsNativeTransaction): Promise<string> {
    const estimatedFee = await this.signer.simulate(
      this.accountAddress,
      [tx.transaction],
      undefined,
    );

    const res = await this.signer.signAndBroadcast(
      this.accountAddress,
      [tx.transaction],
      estimatedFee * 1.1,
    );

    if (res.code !== 0) {
      throw new Error('Transaction failed');
    }

    return res.transactionHash;
  }
}

async function getSignerForChain(
  chainName: ChainName,
  privateKeyAgent: CloudAgentKey,
  multiProtocolProvider: MultiProtocolProvider,
): Promise<IMultiProtocolSigner<ProtocolType>> {
  const protocolType = multiProtocolProvider.getProtocol(chainName);

  await privateKeyAgent.fetch();
  const privateKey = privateKeyAgent.privateKey;

  switch (protocolType) {
    case ProtocolType.Ethereum:
      return new EvmMultiProtocolSignerAdapter(
        chainName,
        privateKey,
        multiProtocolProvider,
      );
    case ProtocolType.Sealevel:
      return new SvmMultiprotocolSignerAdapter(
        chainName,
        privateKey,
        multiProtocolProvider,
      );
    case ProtocolType.CosmosNative:
      return CosmosNativeMultiProtocolSignerAdapter.init(
        chainName,
        privateKey,
        multiProtocolProvider,
      );
    case ProtocolType.Starknet:
      return new StarknetMultiProtocolSignerAdapter(
        chainName,
        privateKey,
        privateKeyAgent.address,
        multiProtocolProvider,
      );
    default:
      throw new Error('');
  }
}

main().catch((err) => {
  logger.error(
    {
      error: format(err),
    },
    'Error occurred in main',
  );
  process.exit(1);
});
