import { EthBridger, getL2Network } from '@arbitrum/sdk';
import { BigNumber, ethers } from 'ethers';
import { Gauge, Registry } from 'prom-client';
import { format } from 'util';

import {
  ChainMap,
  ChainName,
  Chains,
  HyperlaneIgp,
  MultiProvider,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  error,
  log,
  objFilter,
  objMap,
  promiseObjAll,
  warn,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { parseKeyIdentifier } from '../../src/agents/agent';
import { KeyAsAddress, getRoleKeysPerChain } from '../../src/agents/key-utils';
import {
  BaseCloudAgentKey,
  ReadOnlyCloudAgentKey,
} from '../../src/agents/keys';
import { DeployEnvironment } from '../../src/config';
import { deployEnvToSdkEnv } from '../../src/config/environment';
import { ContextAndRoles, ContextAndRolesMap } from '../../src/config/funding';
import { Role } from '../../src/roles';
import { submitMetrics } from '../../src/utils/metrics';
import {
  assertContext,
  assertRole,
  isEthereumProtocolChain,
  readJSONAtPath,
} from '../../src/utils/utils';
import { getAgentConfig, getArgs, getEnvironmentConfig } from '../utils';

import * as L1ETHGateway from './utils/L1ETHGateway.json';
import * as L1MessageQueue from './utils/L1MessageQueue.json';
import * as L1ScrollMessenger from './utils/L1ScrollMessenger.json';
import * as PolygonZkEVMBridge from './utils/PolygonZkEVMBridge.json';

const nativeBridges = {
  scrollsepolia: {
    l1ETHGateway: '0x8A54A2347Da2562917304141ab67324615e9866d',
    l1Messenger: '0x50c7d3e7f7c656493D1D76aaa1a836CedfCBB16A',
  },
  polygonzkevmtestnet: {
    l1EVMBridge: '0xF6BEEeBB578e214CA9E23B0e9683454Ff88Ed2A7',
  },
};

type L2Chain =
  | Chains.optimism
  | Chains.optimismgoerli
  | Chains.arbitrum
  | Chains.arbitrumgoerli
  | Chains.basegoerli
  | Chains.base;

const L2Chains: ChainName[] = [
  Chains.optimism,
  Chains.optimismgoerli,
  Chains.arbitrum,
  Chains.arbitrumgoerli,
  Chains.basegoerli,
  Chains.base,
  Chains.polygonzkevmtestnet,
];

const L2ToL1: ChainMap<ChainName> = {
  optimismgoerli: 'goerli',
  arbitrumgoerli: 'goerli',
  optimism: 'ethereum',
  arbitrum: 'ethereum',
  basegoerli: 'goerli',
  base: 'ethereum',
  polygonzkevmtestnet: 'goerli',
};

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

// Don't send the full amount over to RC keys
const RC_FUNDING_DISCOUNT_NUMERATOR = ethers.BigNumber.from(2);
const RC_FUNDING_DISCOUNT_DENOMINATOR = ethers.BigNumber.from(10);

const desiredBalancePerChain: ChainMap<string> = {
  celo: '0.3',
  alfajores: '1',
  avalanche: '3',
  fuji: '1',
  ethereum: '0.5',
  polygon: '2',
  mumbai: '0.8',
  optimism: '0.5',
  arbitrum: '0.5',
  bsc: '0.05',
  bsctestnet: '1',
  goerli: '0.5',
  sepolia: '0.5',
  moonbasealpha: '1',
  moonbeam: '0.5',
  optimismgoerli: '0.5',
  arbitrumgoerli: '0.5',
  gnosis: '0.1',
  basegoerli: '0.05',
  scrollsepolia: '0.05',
  polygonzkevm: '0.3',
  scroll: '0.3',
  base: '0.3',
  polygonzkevmtestnet: '0.3',

  // unused
  test1: '0',
  test2: '0',
  test3: '0',
};

// Used to fund kathy with more tokens such that it's able to pay interchain gas
// on mainnet. The amount is roughly > $100
const desiredKathyBalancePerChain: ChainMap<string> = {
  celo: '150',
  avalanche: '6',
  polygon: '85',
  ethereum: '0.4',
  optimism: '0.1',
  arbitrum: '0.1',
  bsc: '0.35',
  moonbeam: '250',
  gnosis: '100',
  scroll: '0.05',
  base: '0.05',
  polygonzkevm: '0.05',
};

// The balance threshold of the IGP contract that must be met for the key funder
// to call `claim()`
const igpClaimThresholdPerChain: ChainMap<string> = {
  celo: '5',
  alfajores: '1',
  avalanche: '2',
  fuji: '1',
  ethereum: '0.4',
  polygon: '20',
  mumbai: '1',
  optimism: '0.15',
  arbitrum: '0.1',
  bsc: '0.3',
  bsctestnet: '1',
  goerli: '1',
  sepolia: '1',
  moonbasealpha: '2',
  moonbeam: '5',
  optimismgoerli: '1',
  arbitrumgoerli: '1',
  gnosis: '5',
  basegoerli: '0.1',
  scrollsepolia: '0.1',
  polygonzkevmtestnet: '0.1',
  base: '0.1',
  scroll: '0.1',
  polygonzkevm: '0.1',
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
//   ts-node ./scripts/funding/fund-keys-from-deployer.ts -e testnet4 --context hyperlane --contexts-and-roles rc=relayer
async function main() {
  const { environment, ...argv } = await getArgs()
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
    .default('connection-type', RpcConsensusType.Single)
    .choices('connection-type', [
      RpcConsensusType.Single,
      RpcConsensusType.Quorum,
    ])
    .demandOption('connection-type')

    .boolean('skip-igp-claim')
    .describe('skip-igp-claim', 'If true, never claims funds from the IGP')
    .default('skip-igp-claim', false).argv;

  constMetricLabels.hyperlane_deployment = environment;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider(
    Contexts.Hyperlane, // Always fund from the hyperlane context
    Role.Deployer, // Always fund from the deployer
    argv.connectionType,
  );

  let contextFunders: ContextFunder[];

  if (argv.f) {
    contextFunders = argv.f.map((path) =>
      ContextFunder.fromSerializedAddressFile(
        environment,
        multiProvider,
        argv.contextsAndRoles,
        argv.skipIgpClaim,
        path,
      ),
    );
  } else {
    const contexts = Object.keys(argv.contextsAndRoles) as Contexts[];
    contextFunders = await Promise.all(
      contexts.map((context) =>
        ContextFunder.fromContext(
          environment,
          multiProvider,
          context,
          argv.contextsAndRoles[context]!,
          argv.skipIgpClaim,
        ),
      ),
    );
  }

  let failureOccurred = false;
  for (const funder of contextFunders) {
    failureOccurred ||= await funder.fund();
  }

  await submitMetrics(metricsRegister, 'key-funder');

  if (failureOccurred) {
    error('At least one failure occurred when funding');
    process.exit(1);
  }
}

// Funds keys for a single context
class ContextFunder {
  igp: HyperlaneIgp;

  keysToFundPerChain: ChainMap<BaseCloudAgentKey[]>;

  constructor(
    public readonly environment: DeployEnvironment,
    public readonly multiProvider: MultiProvider,
    roleKeysPerChain: ChainMap<Record<Role, BaseCloudAgentKey[]>>,
    public readonly context: Contexts,
    public readonly rolesToFund: Role[],
    public readonly skipIgpClaim: boolean,
  ) {
    // At the moment, only blessed EVM chains are supported
    roleKeysPerChain = objFilter(
      roleKeysPerChain,
      (chain, _roleKeys): _roleKeys is Record<Role, BaseCloudAgentKey[]> => {
        const valid =
          isEthereumProtocolChain(chain) &&
          multiProvider.tryGetChainName(chain) !== null;
        if (!valid) {
          warn('Skipping funding for non-blessed or non-Ethereum chain', {
            chain,
          });
        }
        return valid;
      },
    );

    this.igp = HyperlaneIgp.fromEnvironment(
      deployEnvToSdkEnv[this.environment],
      multiProvider,
    );
    this.keysToFundPerChain = objMap(roleKeysPerChain, (_chain, roleKeys) => {
      return Object.keys(roleKeys).reduce((agg, roleStr) => {
        const role = roleStr as Role;
        if (this.rolesToFund.includes(role)) {
          return [...agg, ...roleKeys[role]];
        }
        return agg;
      }, [] as BaseCloudAgentKey[]);
    });
  }

  static fromSerializedAddressFile(
    environment: DeployEnvironment,
    multiProvider: MultiProvider,
    contextsAndRolesToFund: ContextAndRolesMap,
    skipIgpClaim: boolean,
    filePath: string,
  ) {
    log('Reading identifiers and addresses from file', {
      filePath,
    });
    // A big array of KeyAsAddress, including keys that we may not care about.
    const allIdsAndAddresses: KeyAsAddress[] = readJSONAtPath(filePath);
    if (!allIdsAndAddresses.length) {
      throw Error(`Expected at least one key in file ${filePath}`);
    }

    // Arbitrarily pick the first key to get the context
    const firstKey = allIdsAndAddresses[0];
    const context = ReadOnlyCloudAgentKey.fromSerializedAddress(
      firstKey.identifier,
      firstKey.address,
    ).context;

    // Indexed by the identifier for quicker lookup
    const idsAndAddresses: Record<string, KeyAsAddress> =
      allIdsAndAddresses.reduce((agg, idAndAddress) => {
        agg[idAndAddress.identifier] = idAndAddress;
        return agg;
      }, {} as Record<string, KeyAsAddress>);

    const agentConfig = getAgentConfig(context, environment);
    // Unfetched keys per chain and role, so we know which keys
    // we need. We'll use this to create a corresponding object
    // of ReadOnlyCloudAgentKeys using addresses found in the
    // serialized address file.
    const roleKeysPerChain = getRoleKeysPerChain(agentConfig);

    const readOnlyKeysPerChain = objMap(
      roleKeysPerChain,
      (_chain, roleKeys) => {
        return objMap(roleKeys, (_role, keys) => {
          return keys.map((key) => {
            const idAndAddress = idsAndAddresses[key.identifier];
            if (!idAndAddress) {
              throw Error(
                `Expected key identifier ${key.identifier} to be in file ${filePath}`,
              );
            }
            return ReadOnlyCloudAgentKey.fromSerializedAddress(
              idAndAddress.identifier,
              idAndAddress.address,
            );
          });
        });
      },
    );

    log('Successfully read keys for context from file', {
      filePath,
      readOnlyKeysPerChain,
      context,
    });

    return new ContextFunder(
      environment,
      multiProvider,
      readOnlyKeysPerChain,
      context,
      contextsAndRolesToFund[context]!,
      skipIgpClaim,
    );
  }

  // The keys here are not ReadOnlyCloudAgentKeys, instead they are AgentGCPKey or AgentAWSKeys,
  // which require credentials to fetch. If you want to avoid requiring credentials, use
  // fromSerializedAddressFile instead.
  static async fromContext(
    environment: DeployEnvironment,
    multiProvider: MultiProvider,
    context: Contexts,
    rolesToFund: Role[],
    skipIgpClaim: boolean,
  ) {
    const agentConfig = getAgentConfig(context, environment);
    const roleKeysPerChain = getRoleKeysPerChain(agentConfig);
    // Fetch all the keys
    await promiseObjAll(
      objMap(roleKeysPerChain, (_chain, roleKeys) => {
        return promiseObjAll(
          objMap(roleKeys, (_role, keys) => {
            return Promise.all(keys.map((key) => key.fetch()));
          }),
        );
      }),
    );

    return new ContextFunder(
      environment,
      multiProvider,
      roleKeysPerChain,
      context,
      rolesToFund,
      skipIgpClaim,
    );
  }

  // Funds all the roles in this.rolesToFund
  // Returns whether a failure occurred.
  async fund(): Promise<boolean> {
    const chainKeyEntries = Object.entries(this.keysToFundPerChain);
    const promises = chainKeyEntries.map(async ([chain, keys]) => {
      let failureOccurred = false;
      if (keys.length > 0) {
        if (!this.skipIgpClaim) {
          failureOccurred ||= await gracefullyHandleError(
            () => this.attemptToClaimFromIgp(chain),
            chain,
            'Error claiming from IGP',
          );
        }

        failureOccurred ||= await gracefullyHandleError(
          () => this.bridgeIfL2(chain),
          chain,
          'Error bridging to L2',
        );
      }
      for (const key of keys) {
        const failure = await this.attemptToFundKey(key, chain);
        failureOccurred ||= failure;
      }
      return failureOccurred;
    });

    // A failure occurred if any of the promises rejected or
    // if any of them resolved with true, indicating a failure
    // somewhere along the way
    const failureOccurred = (await Promise.allSettled(promises)).reduce(
      (failureAgg, result, i) => {
        if (result.status === 'rejected') {
          error('Funding promise for chain rejected', {
            chain: chainKeyEntries[i][0],
            error: format(result.reason),
          });
          return true;
        }
        return result.value || failureAgg;
      },
      false,
    );

    return failureOccurred;
  }

  private async attemptToFundKey(
    key: BaseCloudAgentKey,
    chain: ChainName,
  ): Promise<boolean> {
    const provider = this.multiProvider.tryGetProvider(chain);
    if (!provider) {
      error('Cannot get chain connection', {
        chain,
      });
      // Consider this an error, but don't throw and prevent all future funding attempts
      return true;
    }
    const desiredBalance = this.getDesiredBalanceForRole(chain, key.role);

    let failureOccurred = false;

    try {
      await this.fundKeyIfRequired(chain, key, desiredBalance);
    } catch (err) {
      error('Error funding key', {
        key: await getKeyInfo(
          key,
          chain,
          this.multiProvider.getProvider(chain),
        ),
        context: this.context,
        error: err,
      });
      failureOccurred = true;
    }
    await this.updateWalletBalanceGauge(chain);

    return failureOccurred;
  }

  private async bridgeIfL2(chain: ChainName) {
    if (L2Chains.includes(chain)) {
      const funderAddress = await this.multiProvider.getSignerAddress(chain)!;
      const desiredBalanceEther = ethers.utils.parseUnits(
        desiredBalancePerChain[chain],
        'ether',
      );
      // Optionally bridge ETH to L2 before funding the desired key.
      // By bridging the funder with 10x the desired balance we save
      // on L1 gas.
      const bridgeAmount = await this.getFundingAmount(
        chain,
        funderAddress,
        desiredBalanceEther.mul(5),
      );
      if (bridgeAmount.gt(0)) {
        await this.bridgeToL2(chain as L2Chain, funderAddress, bridgeAmount);
      }
    }
  }

  private async attemptToClaimFromIgp(chain: ChainName) {
    const igpClaimThresholdEther = igpClaimThresholdPerChain[chain];
    if (!igpClaimThresholdEther) {
      warn(`No IGP claim threshold for chain ${chain}`);
      return;
    }
    const igpClaimThreshold = ethers.utils.parseEther(igpClaimThresholdEther);

    const provider = this.multiProvider.getProvider(chain);
    const igp = this.igp.getContracts(chain).interchainGasPaymaster;
    const igpBalance = await provider.getBalance(igp.address);

    log('Checking IGP balance', {
      chain,
      igpBalance: ethers.utils.formatEther(igpBalance),
      igpClaimThreshold: ethers.utils.formatEther(igpClaimThreshold),
    });

    if (igpBalance.gt(igpClaimThreshold)) {
      log('IGP balance exceeds claim threshold, claiming', {
        chain,
      });
      await this.multiProvider.sendTransaction(
        chain,
        await igp.populateTransaction.claim(),
      );
    } else {
      log('IGP balance does not exceed claim threshold, skipping', {
        chain,
      });
    }
  }

  private async getFundingAmount(
    chain: ChainName,
    address: string,
    desiredBalance: BigNumber,
  ): Promise<BigNumber> {
    const currentBalance = await this.multiProvider
      .getProvider(chain)
      .getBalance(address);
    const delta = desiredBalance.sub(currentBalance);
    const minDelta = desiredBalance
      .mul(MIN_DELTA_NUMERATOR)
      .div(MIN_DELTA_DENOMINATOR);
    return delta.gt(minDelta) ? delta : BigNumber.from(0);
  }

  private getDesiredBalanceForRole(chain: ChainName, role: Role): BigNumber {
    const desiredBalanceEther =
      role === Role.Kathy && desiredKathyBalancePerChain[chain]
        ? desiredKathyBalancePerChain[chain]
        : desiredBalancePerChain[chain];
    let desiredBalance = ethers.utils.parseEther(desiredBalanceEther);
    if (this.context === Contexts.ReleaseCandidate) {
      desiredBalance = desiredBalance
        .mul(RC_FUNDING_DISCOUNT_NUMERATOR)
        .div(RC_FUNDING_DISCOUNT_DENOMINATOR);
    }
    return desiredBalance;
  }

  // Tops up the key's balance to the desired balance if the current balance
  // is lower than the desired balance by the min delta
  private async fundKeyIfRequired(
    chain: ChainName,
    key: BaseCloudAgentKey,
    desiredBalance: BigNumber,
  ) {
    const fundingAmount = await this.getFundingAmount(
      chain,
      key.address,
      desiredBalance,
    );
    const keyInfo = await getKeyInfo(
      key,
      chain,
      this.multiProvider.getProvider(chain),
    );
    const funderAddress = await this.multiProvider.getSignerAddress(chain);

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
            await this.multiProvider.getSigner(chain).getBalance(),
          ),
        },
        context: this.context,
      });
    }

    const tx = await this.multiProvider.sendTransaction(chain, {
      to: key.address,
      value: fundingAmount,
    });
    log('Sent transaction', {
      key: keyInfo,
      txUrl: this.multiProvider.tryGetExplorerTxUrl(chain, {
        hash: tx.transactionHash,
      }),
      context: this.context,
      chain,
    });
    log('Got transaction receipt', {
      key: keyInfo,
      tx,
      context: this.context,
      chain,
    });
  }

  private async bridgeToL2(l2Chain: L2Chain, to: string, amount: BigNumber) {
    const l1Chain = L2ToL1[l2Chain];
    log('Bridging ETH to L2', {
      amount: ethers.utils.formatEther(amount),
      l1Funder: await getAddressInfo(
        await this.multiProvider.getSignerAddress(l1Chain),
        l1Chain,
        this.multiProvider.getProvider(l1Chain),
      ),
      l2Funder: await getAddressInfo(
        to,
        l2Chain,
        this.multiProvider.getProvider(l2Chain),
      ),
    });
    let tx;
    if (l2Chain.includes('optimism') || l2Chain.includes('base')) {
      tx = await this.bridgeToOptimism(l2Chain, amount, to);
    } else if (l2Chain.includes('arbitrum')) {
      tx = await this.bridgeToArbitrum(l2Chain, amount);
    } else if (l2Chain.includes('scroll')) {
      tx = await this.bridgeToScroll(l2Chain, amount, to);
    } else if (l2Chain.includes('zkevm')) {
      tx = await this.bridgeToPolygonCDK(l2Chain, amount, to);
    } else {
      throw new Error(`${l2Chain} is not an L2`);
    }
    await this.multiProvider.handleTx(l1Chain, tx);
  }

  private async bridgeToOptimism(
    l2Chain: L2Chain,
    amount: BigNumber,
    to: string,
  ) {
    const l1Chain = L2ToL1[l2Chain];
    const crossChainMessenger = new CrossChainMessenger({
      l1ChainId: this.multiProvider.getDomainId(l1Chain),
      l2ChainId: this.multiProvider.getDomainId(l2Chain),
      l1SignerOrProvider: this.multiProvider.getSignerOrProvider(l1Chain),
      l2SignerOrProvider: this.multiProvider.getSignerOrProvider(l2Chain),
    });
    return crossChainMessenger.depositETH(amount, {
      recipient: to,
      overrides: this.multiProvider.getTransactionOverrides(l1Chain),
    });
  }

  private async bridgeToArbitrum(l2Chain: L2Chain, amount: BigNumber) {
    const l1Chain = L2ToL1[l2Chain];
    const l2Network = await getL2Network(
      this.multiProvider.getDomainId(l2Chain),
    );
    const ethBridger = new EthBridger(l2Network);
    return ethBridger.deposit({
      amount,
      l1Signer: this.multiProvider.getSigner(l1Chain),
      overrides: this.multiProvider.getTransactionOverrides(l1Chain),
    });
  }

  private async bridgeToScroll(
    l2Chain: L2Chain,
    amount: BigNumber,
    to: Address,
  ) {
    const l1Chain = L2ToL1[l2Chain];
    const l1ChainSigner = this.multiProvider.getSigner(l1Chain);
    const l1EthGateway = new ethers.Contract(
      nativeBridges.scrollsepolia.l1ETHGateway,
      L1ETHGateway.abi,
      l1ChainSigner,
    );
    const l1ScrollMessenger = new ethers.Contract(
      nativeBridges.scrollsepolia.l1Messenger,
      L1ScrollMessenger.abi,
      l1ChainSigner,
    );
    const l2GasLimit = BigNumber.from('200000'); // l2 gas amount for the transfer and an empty callback calls
    const l1MessageQueueAddress = await l1ScrollMessenger.messageQueue();
    const l1MessageQueue = new ethers.Contract(
      l1MessageQueueAddress,
      L1MessageQueue.abi,
      l1ChainSigner,
    );
    const gasQuote = await l1MessageQueue.estimateCrossDomainMessageFee(
      l2GasLimit,
    );
    const totalAmount = amount.add(gasQuote);
    return l1EthGateway['depositETH(address,uint256,uint256)'](
      to,
      amount,
      l2GasLimit,
      {
        value: totalAmount,
      },
    );
  }

  private async bridgeToPolygonCDK(
    l2Chain: L2Chain,
    amount: BigNumber,
    to: Address,
  ) {
    const l1Chain = L2ToL1[l2Chain];
    const l1ChainSigner = this.multiProvider.getSigner(l1Chain);
    const polygonZkEVMbridge = new ethers.Contract(
      nativeBridges.polygonzkevmtestnet.l1EVMBridge,
      PolygonZkEVMBridge.abi,
      l1ChainSigner,
    );
    return polygonZkEVMbridge.bridgeAsset(
      1, // 0 is mainnet, 1 is l2
      to,
      amount,
      ethers.constants.AddressZero,
      true,
      [],
      {
        value: amount,
      },
    );
  }

  private async updateWalletBalanceGauge(chain: ChainName) {
    const funderAddress = await this.multiProvider.getSignerAddress(chain);
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
          ethers.utils.formatEther(
            await this.multiProvider.getSigner(chain).getBalance(),
          ),
        ),
      );
  }
}

async function getAddressInfo(
  address: string,
  chain: ChainName,
  provider: ethers.providers.Provider,
) {
  return {
    chain,
    balance: ethers.utils.formatEther(await provider.getBalance(address)),
    address,
  };
}

async function getKeyInfo(
  key: BaseCloudAgentKey,
  chain: ChainName,
  provider: ethers.providers.Provider,
) {
  return {
    ...(await getAddressInfo(key.address, chain, provider)),
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
  const validRoles = new Set([Role.Relayer, Role.Kathy]);
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

// Returns whether an error occurred
async function gracefullyHandleError(
  fn: () => Promise<void>,
  chain: ChainName,
  errorMessage: string,
): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    error(errorMessage, {
      chain,
      error: format(err),
    });
  }
  return true;
}

main().catch((err) => {
  error('Error occurred in main', {
    // JSON.stringifying an Error returns '{}'.
    // This is a workaround from https://stackoverflow.com/a/60370781
    error: format(err),
  });
  process.exit(1);
});
