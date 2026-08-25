import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { StargateClient } from '@cosmjs/stargate';
import {
  ChainBalanceReport,
  ChainFundingConfig,
  FundingPolicy,
  KeyfunderConfig,
  ProtocolType,
  RecipientConfig,
} from '../types';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export interface MonitorOptions {
  timeoutMs?: number;
  maxConcurrency?: number;
  retryCount?: number;
}

export class MultiProtocolBalanceMonitor {
  private timeoutMs: number;
  private maxConcurrency: number;
  private retryCount: number;

  // Cached client instances
  private evmProviders: Map<string, ethers.JsonRpcProvider> = new Map();
  private solanaConnections: Map<string, Connection> = new Map();
  private cosmosClients: Map<string, StargateClient> = new Map();

  constructor(options: MonitorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxConcurrency = options.maxConcurrency ?? 10;
    this.retryCount = options.retryCount ?? 2;
  }

  /**
   * Helper to execute a promise with timeout
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timeout after ${timeoutMs}ms executing ${operationName}`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Execute with fallback RPC URLs on failure
   */
  private async executeWithRpcFallback<T>(
    chainConfig: ChainFundingConfig,
    operationName: string,
    executor: (rpcUrl: string) => Promise<T>
  ): Promise<T> {
    const urls: string[] = [];
    if (chainConfig.rpcUrl) {
      urls.push(chainConfig.rpcUrl);
    }
    if (chainConfig.fallbackRpcUrls && chainConfig.fallbackRpcUrls.length > 0) {
      for (const fallback of chainConfig.fallbackRpcUrls) {
        if (!urls.includes(fallback)) {
          urls.push(fallback);
        }
      }
    }

    if (urls.length === 0) {
      throw new Error(`No RPC URL configured for chain ${chainConfig.chain ?? 'unknown'}`);
    }

    let lastError: Error | undefined;
    for (const rpcUrl of urls) {
      for (let attempt = 0; attempt <= this.retryCount; attempt++) {
        try {
          return await this.withTimeout(
            executor(rpcUrl),
            this.timeoutMs,
            `${operationName} on ${rpcUrl} (attempt ${attempt + 1})`
          );
        } catch (err: any) {
          lastError = err;
          // If this is the last attempt for this RPC, move to next fallback
          if (attempt === this.retryCount) break;
          // Small backoff before retry
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        }
      }
    }

    throw lastError || new Error(`Failed to execute ${operationName} across all RPC endpoints`);
  }

  /**
   * Get or create EVM provider
   */
  public getEvmProvider(rpcUrl: string): ethers.JsonRpcProvider {
    let provider = this.evmProviders.get(rpcUrl);
    if (!provider) {
      provider = new ethers.JsonRpcProvider(rpcUrl);
      this.evmProviders.set(rpcUrl, provider);
    }
    return provider;
  }

  /**
   * Set custom EVM provider (useful for tests and mocks)
   */
  public setEvmProvider(rpcUrl: string, provider: ethers.JsonRpcProvider): void {
    this.evmProviders.set(rpcUrl, provider);
  }

  /**
   * Get or create Solana Connection
   */
  public getSolanaConnection(rpcUrl: string): Connection {
    let conn = this.solanaConnections.get(rpcUrl);
    if (!conn) {
      conn = new Connection(rpcUrl, { commitment: 'confirmed' });
      this.solanaConnections.set(rpcUrl, conn);
    }
    return conn;
  }

  /**
   * Set custom Solana Connection (useful for tests and mocks)
   */
  public setSolanaConnection(rpcUrl: string, connection: Connection): void {
    this.solanaConnections.set(rpcUrl, connection);
  }

  /**
   * Get or create CosmJS StargateClient
   */
  public async getCosmosClient(rpcUrl: string): Promise<StargateClient> {
    let client = this.cosmosClients.get(rpcUrl);
    if (!client) {
      client = await StargateClient.connect(rpcUrl);
      this.cosmosClients.set(rpcUrl, client);
    }
    return client;
  }

  /**
   * Set custom Cosmos Client (useful for tests and mocks)
   */
  public setCosmosClient(rpcUrl: string, client: StargateClient): void {
    this.cosmosClients.set(rpcUrl, client);
  }

  /**
   * Query native gas balance for an address on the given chain
   */
  public async getNativeBalance(chainConfig: ChainFundingConfig, address: string): Promise<bigint> {
    return this.executeWithRpcFallback(chainConfig, `getNativeBalance(${address})`, async (rpcUrl) => {
      switch (chainConfig.protocol) {
        case 'ethereum': {
          const provider = this.getEvmProvider(rpcUrl);
          const balance = await provider.getBalance(address);
          return BigInt(balance.toString());
        }
        case 'sealevel': {
          const connection = this.getSolanaConnection(rpcUrl);
          const pubkey = new PublicKey(address);
          const lamports = await connection.getBalance(pubkey);
          return BigInt(lamports);
        }
        case 'cosmos': {
          const denom = chainConfig.strategyConfig?.denom || 'uatom';
          // Try Stargate RPC client
          try {
            const client = await this.getCosmosClient(rpcUrl);
            const coin = await client.getBalance(address, denom);
            return BigInt(coin.amount);
          } catch (stargateErr) {
            // Fallback to REST endpoint if RPC fails or rpcUrl is HTTP REST
            const restUrl = `${rpcUrl.replace(/\/$/, '')}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${denom}`;
            const res = await fetch(restUrl);
            if (!res.ok) {
              throw new Error(`Cosmos balance query failed: ${stargateErr} / REST: ${res.statusText}`);
            }
            const data: any = await res.json();
            return BigInt(data?.balance?.amount || '0');
          }
        }
        default:
          throw new Error(`Unsupported protocol: ${chainConfig.protocol}`);
      }
    });
  }

  /**
   * Query token balance (ERC20 / SPL / Cosmos token)
   */
  public async getTokenBalance(
    chainConfig: ChainFundingConfig,
    address: string,
    tokenAddress: string
  ): Promise<bigint> {
    return this.executeWithRpcFallback(
      chainConfig,
      `getTokenBalance(${address}, ${tokenAddress})`,
      async (rpcUrl) => {
        switch (chainConfig.protocol) {
          case 'ethereum': {
            const provider = this.getEvmProvider(rpcUrl);
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
            const balance = await tokenContract.balanceOf(address);
            return BigInt(balance.toString());
          }
          case 'sealevel': {
            const connection = this.getSolanaConnection(rpcUrl);
            const ownerPubkey = new PublicKey(address);
            const mintPubkey = new PublicKey(tokenAddress);
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(ownerPubkey, {
              mint: mintPubkey,
            });
            let total = 0n;
            for (const item of tokenAccounts.value) {
              const amountStr = item.account.data.parsed.info.tokenAmount.amount;
              total += BigInt(amountStr);
            }
            return total;
          }
          case 'cosmos': {
            const denom = tokenAddress; // For cosmos, tokenAddress is the denom
            const client = await this.getCosmosClient(rpcUrl);
            const coin = await client.getBalance(address, denom);
            return BigInt(coin.amount);
          }
          default:
            throw new Error(`Unsupported protocol for token balance: ${chainConfig.protocol}`);
        }
      }
    );
  }

  /**
   * Get balance for a specific recipient (native or token)
   */
  public async getRecipientBalance(
    chainConfig: ChainFundingConfig,
    recipient: RecipientConfig
  ): Promise<bigint> {
    if (recipient.tokenAddress || recipient.tokenDenom) {
      const tokenIdentifier = recipient.tokenAddress || recipient.tokenDenom!;
      return this.getTokenBalance(chainConfig, recipient.address, tokenIdentifier);
    }
    return this.getNativeBalance(chainConfig, recipient.address);
  }

  /**
   * Format raw bigint amount into decimal string with proper decimals
   */
  public formatUnits(amount: bigint, decimals: number): string {
    return ethers.formatUnits(amount, decimals);
  }

  /**
   * Parse decimal string into raw bigint amount
   */
  public parseUnits(amountStr: string, decimals: number): bigint {
    return ethers.parseUnits(amountStr, decimals);
  }

  /**
   * Batch query all recipient and funder balances for a chain
   */
  public async getChainBalances(
    chainName: string,
    chainConfig: ChainFundingConfig,
    funderAddress?: string,
    policies?: Record<string, FundingPolicy>
  ): Promise<ChainBalanceReport> {
    const decimals = chainConfig.nativeDecimals ?? 18;

    // 1. Fetch funder balance
    let funderBalance = 0n;
    const resolvedFunderAddress = funderAddress || '0x0000000000000000000000000000000000000000';
    if (funderAddress) {
      try {
        funderBalance = await this.getNativeBalance(chainConfig, funderAddress);
      } catch (err: any) {
        console.warn(`[BalanceMonitor] Failed to fetch funder balance for ${chainName} (${funderAddress}): ${err.message}`);
      }
    }

    // 2. Fetch recipient balances with concurrency control
    const recipientResults: Array<{
      recipient: string;
      name?: string;
      balance: bigint;
      formattedBalance: string;
      minBalance: bigint;
      formattedMinBalance: string;
      desiredBalance: bigint;
      formattedDesiredBalance: string;
      needsFunding: boolean;
      deficit: bigint;
      formattedDeficit: string;
    }> = [];

    const recipients = chainConfig.recipients || [];
    // Process in batches
    for (let i = 0; i < recipients.length; i += this.maxConcurrency) {
      const batch = recipients.slice(i, i + this.maxConcurrency);
      const promises = batch.map(async (rc) => {
        let balance = 0n;
        try {
          balance = await this.getRecipientBalance(chainConfig, rc);
        } catch (err: any) {
          console.warn(`[BalanceMonitor] Failed to fetch balance for recipient ${rc.address} on ${chainName}: ${err.message}`);
          return null;
        }

        // Determine effective policy
        let minBalStr = rc.minBalance;
        let desiredBalStr = rc.desiredBalance;
        if (!minBalStr && rc.policy && policies && policies[rc.policy]) {
          minBalStr = policies[rc.policy].minBalance;
        }
        if (!desiredBalStr && rc.policy && policies && policies[rc.policy]) {
          desiredBalStr = policies[rc.policy].desiredBalance;
        }

        minBalStr = minBalStr || '0';
        desiredBalStr = desiredBalStr || '0';

        const minBalanceBigInt = this.parseUnits(minBalStr, decimals);
        const desiredBalanceBigInt = this.parseUnits(desiredBalStr, decimals);

        const needsFunding = balance < minBalanceBigInt;
        const deficit = needsFunding && desiredBalanceBigInt > balance ? desiredBalanceBigInt - balance : 0n;

        return {
          recipient: rc.address,
          name: rc.name,
          balance,
          formattedBalance: this.formatUnits(balance, decimals),
          minBalance: minBalanceBigInt,
          formattedMinBalance: minBalStr,
          desiredBalance: desiredBalanceBigInt,
          formattedDesiredBalance: desiredBalStr,
          needsFunding,
          deficit,
          formattedDeficit: this.formatUnits(deficit, decimals),
        };
      });

      const settled = await Promise.all(promises);
      for (const item of settled) {
        if (item !== null) {
          recipientResults.push(item);
        }
      }
    }

    return {
      chain: chainName,
      protocol: chainConfig.protocol,
      funderAddress: resolvedFunderAddress,
      funderBalance,
      formattedFunderBalance: this.formatUnits(funderBalance, decimals),
      recipientBalances: recipientResults,
    };
  }

  /**
   * Query all balances across all chains in KeyfunderConfig
   */
  public async getAllBalances(
    config: KeyfunderConfig,
    funderAddresses?: Record<string, string>
  ): Promise<Record<string, ChainBalanceReport>> {
    const reports: Record<string, ChainBalanceReport> = {};
    const chainEntries = Object.entries(config.chains);

    const promises = chainEntries.map(async ([chainName, chainConfig]) => {
      const funderAddr = funderAddresses ? funderAddresses[chainName] : undefined;
      const report = await this.getChainBalances(chainName, chainConfig, funderAddr, config.policies);
      return { chainName, report };
    });

    const results = await Promise.all(promises);
    for (const { chainName, report } of results) {
      reports[chainName] = report;
    }

    return reports;
  }
}
