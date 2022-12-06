import { EthBridger, getL2Network } from '@arbitrum/sdk';
import { BigNumber, ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import { format } from 'util';

import {
  AllChains,
  ChainConnection,
  ChainName,
  ChainNameToDomainId,
  CompleteChainMap,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { error, log } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { parseKeyIdentifier } from '../../src/agents/agent';
import { getAllCloudAgentKeys } from '../../src/agents/key-utils';
import {
  BaseCloudAgentKey,
  ReadOnlyCloudAgentKey,
} from '../../src/agents/keys';
import { KEY_ROLE_ENUM } from '../../src/agents/roles';
import { ConnectionType } from '../../src/config/agent';
import { ContextAndRoles, ContextAndRolesMap } from '../../src/config/funding';
import { submitMetrics } from '../../src/utils/metrics';
import {
  assertContext,
  assertRole,
  readJSONAtPath,
} from '../../src/utils/utils';
import {
  assertEnvironment,
  getAgentConfig,
  getArgs,
  getCoreEnvironmentConfig,
} from '../utils';

// Missing types declaration for bufio
const CrossChainMessenger = require('@eth-optimism/sdk').CrossChainMessenger; // eslint-disable-line

const constMetricLabels = {
  // this needs to get set in main because of async reasons
  hyperlane_deployment: '',
  hyperlane_context: 'hyperlane',
};

const metricsRegister = new Registry();

const walletBalanceGauge = new Gauge({
  // Mirror the rust/ethers-prometheus `wallet_balance` gauge metric.
  name: 'hyperlane_wallet_balance',
  help: 'Current balance of eth and other tokens in the `tokens` map for the wallet addresses in the `wallets` set',
  registers: [metricsRegister],
  labelNames: [
    'chain',
    'wallet_address',
    'wallet_name',
    'token_address',
    'token_symbol',
    'token_name',
    ...(Object.keys(constMetricLabels) as (keyof typeof constMetricLabels)[]),
  ],
});
metricsRegister.registerMetric(walletBalanceGauge);

// Min delta is 50% of the desired balance
const MIN_DELTA_NUMERATOR = ethers.BigNumber.from(5);
const MIN_DELTA_DENOMINATOR = ethers.BigNumber.from(10);

const desiredBalancePerChain: CompleteChainMap<string> = {
  celo: '0.1',
  alfajores: '1',
  avalanche: '0.1',
  fuji: '1',
  ethereum: '0.2',
  polygon: '1',
  mumbai: '0.5',
  optimism: '0.05',
  arbitrum: '0.01',
  bsc: '0.01',
  bsctestnet: '1',
  goerli: '0.5',
  moonbasealpha: '1',
  moonbeam: '0.1',
  optimismgoerli: '0.1',
  arbitrumgoerli: '0.1',
  // unused
  test1: '0',
  test2: '0',
  test3: '0',
};

// Funds key addresses for multiple contexts from the deployer key of the context
// specified via the `--context` flag.
// The --contexts-and-roles flag is used to specify the contexts and the key roles
// for each context to fund.
// There are two ways to configure this script so that key addresses are known.
// You can pass in files using `-f`, which are expected to each be JSON arrays of objects
// of the form { identifier: '..', address: '..' }, where the keys described in one file
// are all for the same context. This will avoid requiring any sort of GCP/AWS credentials for
// fetching addresses from the keys themselves. A file for each context specified in --contexts-and-roles
// must be provided
// If the -f flag is not provided, addresses will be read directly from GCP/AWS for each
// context provided in --contexts-and-roles, which requires the appropriate credentials.
//
// Example usage:
//   ts-node ./scripts/funding/fund-keys-from-deployer.ts -e testnet2 --context hyperlane --contexts-and-roles hyperlane=relayer
async function main() {
  const argv = await getArgs()
    .string('f')
    .array('f')
    .alias('f', 'address-files')
    .describe(
      'f',
      'Files each containing JSON arrays of identifier and address objects for a single context. If not specified, key addresses are fetched from GCP/AWS and require sufficient credentials.',
    )

    .string('contexts-and-roles')
    .array('contexts-and-roles')
    .describe(
      'contexts-and-roles',
      'Array indicating contexts and the roles to fund for each context. Each element is expected as <context>=<role>,<role>,<role>...',
    )
    .coerce('contexts-and-roles', parseContextAndRolesMap)
    .demandOption('contexts-and-roles')

    .string('connection-type')
    .describe('connection-type', 'The provider connection type to use for RPCs')
    .default('connection-type', ConnectionType.Http)
    .choices('connection-type', [
      ConnectionType.Http,
      ConnectionType.HttpQuorum,
    ])
    .demandOption('connection-type').argv;

  const environment = assertEnvironment(argv.e as string);
  constMetricLabels.hyperlane_deployment = environment;
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider(
    Contexts.Hyperlane, // Always fund from the hyperlane context
    KEY_ROLE_ENUM.Deployer, // Always fund from the deployer
    argv.connectionType,
  );

  let contextFunders: ContextFunder[];

  if (argv.f) {
    contextFunders = argv.f.map((path) =>
      ContextFunder.fromSerializedAddressFile(
        multiProvider,
        path,
        argv.contextsAndRoles,
      ),
    );
  } else {
    contextFunders = [];
    const contexts = Object.keys(argv.contextsAndRoles) as Contexts[];
    contextFunders = await Promise.all(
      contexts.map((context) =>
        ContextFunder.fromContext(
          multiProvider,
          context,
          argv.contextsAndRoles[context]!,
        ),
      ),
    );
  }

  let failureOccurred = false;
  for (const funder of contextFunders) {
    const failure = await funder.fund();
    if (failure) {
      failureOccurred = true;
    }
  }

  await submitMetrics(metricsRegister, 'key-funder');

  if (failureOccurred) {
    error('At least one failure occurred when funding');
    process.exit(1);
  }
}

// Funds keys for a single context
class ContextFunder {
  public readonly chains: ChainName[];

  constructor(
    public readonly multiProvider: MultiProvider<any>,
    public readonly keys: BaseCloudAgentKey[],
    public readonly context: Contexts,
    public readonly rolesToFund: KEY_ROLE_ENUM[],
  ) {
    const uniqueChains = new Set(
      keys.map((key) => key.chainName!).filter((chain) => chain !== undefined),
    );

    this.chains = Array.from(uniqueChains);
  }

  static fromSerializedAddressFile(
    multiProvider: MultiProvider<any>,
    path: string,
    contextsAndRolesToFund: ContextAndRolesMap,
  ) {
    log('Reading identifiers and addresses from file', {
      path,
    });
    const idsAndAddresses = readJSONAtPath(path);
    const keys: BaseCloudAgentKey[] = idsAndAddresses
      .filter((idAndAddress: any) => {
        const parsed = parseKeyIdentifier(idAndAddress.identifier);
        // Filter out any invalid chain names. This can happen if we're running an old
        // version of this script but the list of identifiers (expected to be stored in GCP secrets)
        // references newer chains.
        return (
          parsed.chainName === undefined ||
          AllChains.includes(parsed.chainName as ChainName)
        );
      })
      .map((idAndAddress: any) =>
        ReadOnlyCloudAgentKey.fromSerializedAddress(
          idAndAddress.identifier,
          idAndAddress.address,
        ),
      );

    // TODO: Why do we need to cast here?
    const context = keys[0].context as Contexts;
    // Ensure all keys have the same context, just to be safe
    for (const key of keys) {
      if (key.context !== context) {
        throw Error(
          `Expected all keys at path ${path} to have context ${context}, found ${key.context}`,
        );
      }
    }

    const rolesToFund = contextsAndRolesToFund[context];
    if (!rolesToFund) {
      throw Error(
        `Expected context ${context} to be defined in contextsAndRolesToFund`,
      );
    }

    log('Read keys for context from file', {
      path,
      keyCount: keys.length,
      context,
    });

    return new ContextFunder(multiProvider, keys, context, rolesToFund);
  }

  // The keys here are not ReadOnlyCloudAgentKeys, instead they are AgentGCPKey or AgentAWSKeys,
  // which require credentials to fetch. If you want to avoid requiring credentials, use
  // fromSerializedAddressFile instead.
  static async fromContext(
    multiProvider: MultiProvider<any>,
    context: Contexts,
    rolesToFund: KEY_ROLE_ENUM[],
  ) {
    const agentConfig = await getAgentConfig(context);
    const keys = getAllCloudAgentKeys(agentConfig);
    await Promise.all(keys.map((key) => key.fetch()));
    return new ContextFunder(multiProvider, keys, context, rolesToFund);
  }

  // Funds all the roles in this.rolesToFund
  // Returns whether a failure occurred.
  async fund(): Promise<boolean> {
    let failureOccurred = false;

    const keysAndChains = this.getKeysAndChains();
    const chains = keysAndChains.map((kAC) => kAC[1]);
    await this.bridgeToL2s(chains);

    for (const [key, chain] of keysAndChains) {
      const failure = await this.attemptToFundKey(key, chain);
      failureOccurred = failureOccurred || failure;
    }
    return failureOccurred;
  }

  private getKeysAndChains() {
    const keysAndChains: [BaseCloudAgentKey, ChainName][] = [];
    for (const role of this.rolesToFund) {
      const keys = this.getKeysWithRole(role);
      for (const chain of this.chains) {
        // Relayer keys should not be funded on the origin chain.
        const filteredKeys = keys.filter(
          (key) => role !== KEY_ROLE_ENUM.Relayer || key.chainName !== chain,
        );
        filteredKeys.map((key) => keysAndChains.push([key, chain]));
      }
    }
    return keysAndChains;
  }

  private async attemptToFundKey(
    key: BaseCloudAgentKey,
    chain: ChainName,
  ): Promise<boolean> {
    const chainConnection = this.multiProvider.tryGetChainConnection(chain);
    if (!chainConnection) {
      error('Cannot get chain connection', {
        chain,
      });
      // Consider this an error, but don't throw and prevent all future funding attempts
      return true;
    }
    const desiredBalance = desiredBalancePerChain[chain];

    let failureOccurred = false;

    try {
      await this.fundKeyIfRequired(chainConnection, chain, key, desiredBalance);
    } catch (err) {
      error('Error funding key', {
        key: await getKeyInfo(key, chain, chainConnection),
        context: this.context,
        error: err,
      });
      failureOccurred = true;
    }
    await this.updateWalletBalanceGauge(chainConnection, chain);

    return failureOccurred;
  }

  private async bridgeToL2s(chains: ChainName[]) {
    const l2s: ChainName[] = [
      'optimism',
      'arbitrum',
      'optimismgoerli',
      'arbitrumgoerli',
    ];
    for (const l2 of l2s) {
      if (chains.includes(l2)) {
        const chainConnection = this.multiProvider.tryGetChainConnection(l2)!;
        const funderAddress = await chainConnection.getAddress()!;
        const desiredBalanceEther = ethers.utils.parseUnits(
          desiredBalancePerChain[l2],
          'ether',
        );
        // Optionally bridge ETH to L2 before funding the desired key.
        // By bridging the funder with 10x the desired balance we save
        // on L1 gas.
        const bridgeAmount = await this.getFundingAmount(
          chainConnection,
          l2,
          funderAddress,
          desiredBalanceEther.mul(10),
        );
        if (bridgeAmount.gt(0)) {
          await this.bridgeToL2(l2, funderAddress, bridgeAmount);
        }
      }
    }
  }

  private async getFundingAmount(
    chainConnection: ChainConnection,
    chain: ChainName,
    address: string,
    desiredBalance: BigNumber,
  ): Promise<BigNumber> {
    const currentBalance = await chainConnection.provider.getBalance(address);
    const delta = desiredBalance.sub(currentBalance);
    const minDelta = desiredBalance
      .mul(MIN_DELTA_NUMERATOR)
      .div(MIN_DELTA_DENOMINATOR);
    return delta.gt(minDelta) ? delta : BigNumber.from(0);
  }

  // Tops up the key's balance to the desired balance if the current balance
  // is lower than the desired balance by the min delta
  private async fundKeyIfRequired(
    chainConnection: ChainConnection,
    chain: ChainName,
    key: BaseCloudAgentKey,
    desiredBalance: string,
  ) {
    const desiredBalanceEther = ethers.utils.parseUnits(
      desiredBalance,
      'ether',
    );
    const fundingAmount = await this.getFundingAmount(
      chainConnection,
      chain,
      key.address,
      desiredBalanceEther,
    );
    const keyInfo = await getKeyInfo(key, chain, chainConnection);
    const funderAddress = await chainConnection.getAddress()!;

    if (fundingAmount.eq(0)) {
      log('Skipping funding for key', {
        key: keyInfo,
        context: this.context,
        chain,
      });
      return;
    } else {
      log('Funding key', {
        chain,
        amount: ethers.utils.formatEther(fundingAmount),
        key: keyInfo,
        funder: {
          address: funderAddress,
          balance: ethers.utils.formatEther(
            await chainConnection.signer!.getBalance(),
          ),
        },
        context: this.context,
      });
    }

    const tx = await chainConnection.signer!.sendTransaction({
      to: key.address,
      value: fundingAmount,
      ...chainConnection.overrides,
    });
    log('Sent transaction', {
      key: keyInfo,
      txUrl: chainConnection.getTxUrl(tx),
      context: this.context,
      chain,
    });
    const receipt = await tx.wait(chainConnection.confirmations);
    log('Got transaction receipt', {
      key: keyInfo,
      receipt,
      context: this.context,
      chain,
    });
  }

  private async bridgeToL2(l2Chain: ChainName, to: string, amount: BigNumber) {
    const testnet = l2Chain.includes('goerli');
    const l1Chain: ChainName = testnet ? 'goerli' : 'ethereum';
    const l1ChainConnection =
      this.multiProvider.tryGetChainConnection(l1Chain)!;
    const l2ChainConnection =
      this.multiProvider.tryGetChainConnection(l2Chain)!;
    log('Bridging ETH to L2', {
      amount: ethers.utils.formatEther(amount),
      l1Funder: await getAddressInfo(
        await l1ChainConnection.getAddress()!,
        l1Chain,
        l1ChainConnection,
      ),
      l2Funder: await getAddressInfo(to, l2Chain, l2ChainConnection),
    });
    let tx;
    if (l2Chain.includes('optimism')) {
      const crossChainMessenger = new CrossChainMessenger({
        l1ChainId: ChainNameToDomainId[l1Chain],
        l2ChainId: ChainNameToDomainId[l2Chain],
        l1SignerOrProvider: l1ChainConnection.signer!,
        l2SignerOrProvider: l2ChainConnection.provider,
      });
      tx = crossChainMessenger.depositETH(amount, {
        recipient: to,
        overrides: l1ChainConnection.overrides,
      });
    } else if (l2Chain.includes('arbitrum')) {
      const l2Network = await getL2Network(ChainNameToDomainId[l2Chain]);
      const ethBridger = new EthBridger(l2Network);
      tx = await ethBridger.deposit({
        amount,
        l1Signer: l1ChainConnection.signer!,
        overrides: l1ChainConnection.overrides,
      });
    } else {
      throw new Error(`${l2Chain} is not an L2`);
    }
    await l1ChainConnection.handleTx(tx);
  }

  private async updateWalletBalanceGauge(
    chainConnection: ChainConnection,
    chain: ChainName,
  ) {
    const funderAddress = await chainConnection.getAddress();
    walletBalanceGauge
      .labels({
        chain,
        wallet_address: funderAddress ?? 'unknown',
        wallet_name: 'key-funder',
        token_symbol: 'Native',
        token_name: 'Native',
        ...constMetricLabels,
      })
      .set(
        parseFloat(
          ethers.utils.formatEther(await chainConnection.signer!.getBalance()),
        ),
      );
  }

  private getKeysWithRole(role: KEY_ROLE_ENUM) {
    return this.keys.filter((k) => k.role === role);
  }
}

async function getAddressInfo(
  address: string,
  chain: ChainName,
  chainConnection: ChainConnection,
) {
  return {
    chain,
    balance: ethers.utils.formatEther(
      await chainConnection.provider.getBalance(address),
    ),
    address,
  };
}

async function getKeyInfo(
  key: BaseCloudAgentKey,
  chain: ChainName,
  chainConnection: ChainConnection,
) {
  return {
    ...(await getAddressInfo(key.address, chain, chainConnection)),
    context: key.context,
    originChain: key.chainName,
    role: key.role,
  };
}

function parseContextAndRolesMap(strs: string[]): ContextAndRolesMap {
  const contextsAndRoles = strs.map(parseContextAndRoles);
  return contextsAndRoles.reduce(
    (prev, curr) => ({
      ...prev,
      [curr.context]: curr.roles,
    }),
    {},
  );
}

// Parses strings of the form <context>=<role>,<role>,<role>...
// e.g.:
//   hyperlane=relayer
//   flowcarbon=relayer,kathy
function parseContextAndRoles(str: string): ContextAndRoles {
  const [contextStr, rolesStr] = str.split('=');
  const context = assertContext(contextStr);

  const roles = rolesStr.split(',').map(assertRole);
  if (roles.length === 0) {
    throw Error('Expected > 0 roles');
  }

  // For now, restrict the valid roles we think are reasonable to want to fund
  const validRoles = new Set([KEY_ROLE_ENUM.Relayer, KEY_ROLE_ENUM.Kathy]);
  for (const role of roles) {
    if (!validRoles.has(role)) {
      throw Error(
        `Invalid role ${role}, must be one of ${Array.from(validRoles)}`,
      );
    }
  }

  return {
    context,
    roles,
  };
}

main().catch((err) => {
  error('Error occurred in main', {
    // JSON.stringifying an Error returns '{}'.
    // This is a workaround from https://stackoverflow.com/a/60370781
    error: format(err),
  });
  process.exit(1);
});
