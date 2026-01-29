import { BigNumber, ethers } from 'ethers';
import { join } from 'path';
import YAML from 'yaml';
import { fromZodError } from 'zod-validation-error';

import { KeyFunderConfigSchema } from '@hyperlane-xyz/keyfunder';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';

import { Contexts } from '../../config/contexts.js';
import { DockerImageRepos } from '../../config/docker.js';
import rebalancerAddresses from '../../config/rebalancer.json' with { type: 'json' };
import { getEnvAddresses } from '../../config/registry.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { relayerAddresses } from '../agents/key-utils.js';
import { AgentContextConfig } from '../config/agent/agent.js';
import { DeployEnvironment, EnvironmentConfig } from '../config/environment.js';
import { DEFAULT_SWEEP_ADDRESS, KeyFunderConfig } from '../config/funding.js';
import { FundableRole, Role } from '../roles.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath, isEthereumProtocolChain } from '../utils/utils.js';

const RC_FUNDING_DISCOUNT_NUMERATOR = BigNumber.from(2);
const RC_FUNDING_DISCOUNT_DENOMINATOR = BigNumber.from(10);

// Chains to sweep excess funds from (must match fund-keys-from-deployer.ts)
const CHAINS_TO_SWEEP = new Set([
  'arbitrum',
  'avalanche',
  'base',
  'blast',
  'bsc',
  'celo',
  'ethereum',
  'fraxtal',
  'hyperevm',
  'ink',
  'linea',
  'lisk',
  'mitosis',
  'optimism',
  'polygon',
  'soneium',
  'superseed',
  'unichain',
]);

export class KeyFunderHelmManager extends HelmManager {
  readonly helmReleaseName: string = 'key-funder';
  readonly helmChartPath: string = join(getInfraPath(), './helm/key-funder/');

  constructor(
    readonly config: KeyFunderConfig<string[]>,
    readonly agentConfig: AgentContextConfig,
    readonly registryCommit: string,
  ) {
    super();
  }

  static forEnvironment(
    environment: DeployEnvironment,
    registryCommit: string,
  ): KeyFunderHelmManager {
    const envConfig = getEnvironmentConfig(environment);
    const keyFunderConfig = getKeyFunderConfig(envConfig);
    const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
    return new KeyFunderHelmManager(
      keyFunderConfig,
      agentConfig,
      registryCommit,
    );
  }

  get namespace() {
    return this.config.namespace;
  }

  async helmValues() {
    const registryUri = `${DEFAULT_GITHUB_REGISTRY}/tree/${this.registryCommit}`;
    const keyfunderConfig = this.generateKeyfunderYaml();

    return {
      cronjob: {
        schedule: this.config.cronSchedule,
      },
      hyperlane: {
        runEnv: this.agentConfig.runEnv,
        chains: this.getEthereumChains(),
        registryUri,
        keyfunderConfig,
        chainsToSkip: this.config.chainsToSkip,
        skipIgpClaim: false,
        prometheusPushGateway: this.config.prometheusPushGateway,
      },
      image: {
        repository: DockerImageRepos.KEY_FUNDER,
        tag: this.config.docker.tag,
      },
    };
  }

  private getEthereumChains(): string[] {
    return this.agentConfig.environmentChainNames.filter((chain) =>
      isEthereumProtocolChain(chain),
    );
  }

  private generateKeyfunderYaml(): string {
    const environment = this.agentConfig.runEnv;
    const roles: Record<string, RoleYamlConfig> = {};
    const chains: Record<string, ChainYamlConfig> = {};
    const envAddresses = getEnvAddresses(environment);

    const roleAddressMap = this.buildRoleAddressMap(environment);
    for (const [roleName, address] of Object.entries(roleAddressMap)) {
      roles[roleName] = { address };
    }

    for (const chain of this.getEthereumChains()) {
      if (this.config.chainsToSkip?.includes(chain)) continue;

      const chainConfig: ChainYamlConfig = {};

      const balances = this.getBalancesForChain(chain, roleAddressMap);
      if (Object.keys(balances).length > 0) {
        chainConfig.balances = balances;
      }

      const igpAddress = envAddresses[chain]?.interchainGasPaymaster;
      const igpThreshold = this.config.igpClaimThresholdPerChain?.[chain];
      if (igpAddress && igpThreshold) {
        chainConfig.igp = {
          address: igpAddress,
          claimThreshold: igpThreshold,
        };
      }

      if (!CHAINS_TO_SWEEP.has(chain)) {
        continue;
      }

      const sweepThreshold = this.config.lowUrgencyKeyFunderBalances?.[chain];
      if (!sweepThreshold || parseFloat(sweepThreshold) <= 0) {
        throw new Error(`Sweep threshold is invalid for chain ${chain}`);
      }

      const override = this.config.sweepOverrides?.[chain];
      chainConfig.sweep = {
        enabled: true,
        address: override?.sweepAddress ?? DEFAULT_SWEEP_ADDRESS,
        threshold: sweepThreshold,
        targetMultiplier: override?.targetMultiplier ?? 1.5,
        triggerMultiplier: override?.triggerMultiplier ?? 2.0,
      };

      if (Object.keys(chainConfig).length > 0) {
        chains[chain] = chainConfig;
      }
    }

    const config = {
      version: '1' as const,
      roles,
      chains,
      metrics: {
        jobName: `keyfunder-${environment}`,
        labels: {
          environment,
        },
      },
      chainsToSkip: this.config.chainsToSkip,
    };

    const validationResult = KeyFunderConfigSchema.safeParse(config);
    if (!validationResult.success) {
      throw new Error(
        `Invalid keyfunder config: ${fromZodError(validationResult.error).message}`,
      );
    }

    return YAML.stringify(validationResult.data);
  }

  private buildRoleAddressMap(
    environment: DeployEnvironment,
  ): Record<string, string> {
    const roleAddressMap: Record<string, string> = {};
    const contextsAndRoles = this.config.contextsAndRolesToFund;

    for (const [contextStr, roles] of Object.entries(contextsAndRoles)) {
      const context = contextStr as Contexts;
      if (!roles) continue;

      for (const role of roles) {
        const address = this.getAddressForRole(environment, context, role);
        if (!address) {
          throw new Error(
            `No address found for role ${role} in context ${context} for environment ${environment}. ` +
              `Ensure the role is configured in the appropriate addresses file.`,
          );
        }
        const roleName = `${context}-${role}`;
        roleAddressMap[roleName] = address;
      }
    }

    return roleAddressMap;
  }

  private getBalancesForChain(
    chain: string,
    roleAddressMap: Record<string, string>,
  ): Record<string, string> {
    const balances: Record<string, string> = {};
    const contextsAndRoles = this.config.contextsAndRolesToFund;

    for (const [contextStr, roles] of Object.entries(contextsAndRoles)) {
      const context = contextStr as Contexts;
      if (!roles) continue;

      for (const role of roles) {
        const roleName = `${context}-${role}`;
        if (!roleAddressMap[roleName]) continue;

        const desiredBalance = this.getDesiredBalanceForRole(chain, role);
        if (desiredBalance && desiredBalance !== '0') {
          const adjustedBalance =
            context === Contexts.ReleaseCandidate
              ? this.applyRcDiscount(desiredBalance)
              : desiredBalance;
          balances[roleName] = adjustedBalance;
        }
      }
    }

    return balances;
  }

  private getAddressForRole(
    environment: DeployEnvironment,
    context: Contexts,
    role: FundableRole,
  ): string | undefined {
    const envAddresses = this.getRoleAddresses(role);
    return envAddresses?.[environment]?.[context];
  }

  private getRoleAddresses(
    role: FundableRole,
  ): Record<DeployEnvironment, Record<Contexts, string>> | undefined {
    switch (role) {
      case Role.Relayer:
        return relayerAddresses as Record<
          DeployEnvironment,
          Record<Contexts, string>
        >;
      case Role.Rebalancer:
        return rebalancerAddresses as Record<
          DeployEnvironment,
          Record<Contexts, string>
        >;
      default:
        return undefined;
    }
  }

  private getDesiredBalanceForRole(
    chain: string,
    role: FundableRole,
  ): string | undefined {
    switch (role) {
      case Role.Relayer:
        return this.config.desiredBalancePerChain[chain];
      case Role.Rebalancer:
        return this.config.desiredRebalancerBalancePerChain?.[chain];
      default:
        return undefined;
    }
  }

  private applyRcDiscount(balance: string): string {
    const discountedBalance = ethers.utils
      .parseEther(balance)
      .mul(RC_FUNDING_DISCOUNT_NUMERATOR)
      .div(RC_FUNDING_DISCOUNT_DENOMINATOR);
    return ethers.utils.formatEther(discountedBalance);
  }
}

interface RoleYamlConfig {
  address: string;
}

interface ChainYamlConfig {
  balances?: Record<string, string>;
  igp?: {
    address: string;
    claimThreshold: string;
  };
  sweep?: {
    enabled: boolean;
    address: string;
    threshold: string;
    targetMultiplier: number;
    triggerMultiplier: number;
  };
}

export function getKeyFunderConfig(
  coreConfig: EnvironmentConfig,
): KeyFunderConfig<string[]> {
  const keyFunderConfig = coreConfig.keyFunderConfig;
  if (!keyFunderConfig) {
    throw new Error(
      `Environment ${coreConfig.environment} does not have a KeyFunderConfig config`,
    );
  }
  return keyFunderConfig;
}
