import { expect } from 'chai';

import { AgentConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { Contexts, RELEASE_CANDIDATE_INDEX_FROM } from '../config/contexts.js';
import { DockerImageRepos, testnetDockerTags } from '../config/docker.js';
import {
  agents as mainnet3Agents,
  hyperlaneContextAgentChainConfig as mainnet3AgentChainConfig,
} from '../config/environments/mainnet3/agent.js';
import { mainnet3SupportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import {
  agents as testnet4Agents,
  hyperlaneContextAgentChainConfig as testnet4AgentChainConfig,
} from '../config/environments/testnet4/agent.js';
import { testnet4SupportedChainNames } from '../config/environments/testnet4/supportedChainNames.js';
import { getChain } from '../config/registry.js';
import { getAgentConfigJsonPath } from '../scripts/agent-utils.js';
import {
  AgentConfigHelper,
  type AgentChainConfig,
  ensureAgentChainConfigIncludesAllChainNames,
  type RootAgentConfig,
} from '../src/config/agent/agent.js';
import { AgentHelmManager } from '../src/agents/index.js';
import { RelayerConfigHelper } from '../src/config/agent/relayer.js';
import { ScraperConfigHelper } from '../src/config/agent/scraper.js';
import { ValidatorConfigHelper } from '../src/config/agent/validator.js';
import { AgentEnvironment } from '../src/config/deploy-environment.js';
import { AgentRole, Role } from '../src/roles.js';

function configuredScraperAgentClients(
  agents: Record<string, RootAgentConfig>,
): number {
  return Object.values(agents).reduce((total, config) => {
    const validatorClients = config.validators?.websocketUrl
      ? config.contextChainNames.validator.reduce(
          (sum, chain) =>
            sum + (config.validators?.chains[chain]?.validators.length ?? 0),
          0,
        )
      : 0;
    // Reserve one connection for each relayer context as those contexts move
    // onto the shared scraper stream.
    const relayerClients = config.relayer ? 1 : 0;
    return total + validatorClients + relayerClients;
  }, 0);
}

const environmentChainConfigs = {
  mainnet3: {
    agentChainConfig: mainnet3AgentChainConfig,
    // We read the agent config from the file system instead of importing
    // to get around the agent JSON configs living outside the typescript rootDir
    agentJsonConfig: readJson<AgentConfig>(
      getAgentConfigJsonPath(AgentEnvironment.Mainnet),
    ),
    supportedChainNames: mainnet3SupportedChainNames,
  },
  testnet4: {
    agentChainConfig: testnet4AgentChainConfig,
    agentJsonConfig: readJson<AgentConfig>(
      getAgentConfigJsonPath(AgentEnvironment.Testnet),
    ),
    supportedChainNames: testnet4SupportedChainNames,
  },
};

class TestAgentHelmManager extends AgentHelmManager {
  readonly helmReleaseName = 'test';

  constructor(
    protected readonly config: AgentConfigHelper,
    readonly role: AgentRole,
  ) {
    super();
  }
}

function agentConfigHelper(
  config: RootAgentConfig,
  role: AgentRole,
): AgentConfigHelper {
  switch (role) {
    case Role.Relayer:
      return new RelayerConfigHelper(config);
    case Role.Scraper:
      return new ScraperConfigHelper(config);
    case Role.Validator: {
      const chain = config.contextChainNames[Role.Validator][0];
      if (!chain) throw new Error('Validator context has no configured chain');
      return new ValidatorConfigHelper(config, chain);
    }
  }
}

describe('Agent configs', () => {
  it('configures one shared testnet4 scraper proxy', () => {
    const enabledProxies = Object.values(testnet4Agents).filter(
      (config) => config.scraperProxy?.enabled,
    );

    expect(enabledProxies).to.have.length(1);
    expect(enabledProxies[0].scraperProxy).to.deep.equal({
      docker: {
        repo: DockerImageRepos.NODE_SERVICES,
        tag: testnetDockerTags.scraperProxy,
      },
      enabled: true,
      port: 8383,
      replicas: 1,
      maxAgentClients: 100,
      tunnel: { enabled: false },
      resources: {
        requests: { cpu: '500m', memory: '1Gi' },
      },
    });
  });

  it('renders fallback hedging only for EVM relayers and scrapers', async () => {
    let sawEthereum = false;
    let sawNonEthereum = false;

    for (const agentConfigs of [mainnet3Agents, testnet4Agents]) {
      for (const config of Object.values(agentConfigs)) {
        for (const role of [
          Role.Relayer,
          Role.Scraper,
          Role.Validator,
        ] as const) {
          const roleDefined =
            role === Role.Validator ? config.validators : config[role];
          if (!roleDefined) continue;

          const manager = new TestAgentHelmManager(
            agentConfigHelper(config, role),
            role,
          );
          const values = await manager.helmValues();

          for (const chain of values.hyperlane.chains) {
            const isEthereum =
              getChain(chain.name).protocol === ProtocolType.Ethereum;
            sawEthereum ||= isEthereum;
            sawNonEthereum ||= !isEthereum;

            const shouldHedge = isEthereum && role !== Role.Validator;
            expect(chain.fallbackHedgeDelayMillis).to.equal(
              shouldHedge ? 250 : undefined,
            );
            expect(chain.fallbackHedgeTimeoutMillis).to.equal(
              shouldHedge ? 30_000 : undefined,
            );
          }
        }
      }
    }

    expect(sawEthereum).to.equal(true);
    expect(sawNonEthereum).to.equal(true);
  });

  it('rejects partial fallback hedge configuration', async () => {
    const config = testnet4Agents[Contexts.Hyperlane];
    for (const relayer of [
      { ...config.relayer!, fallbackHedgeTimeoutMillis: undefined },
      { ...config.relayer!, fallbackHedgeDelayMillis: undefined },
    ]) {
      const partialConfig = { ...config, relayer };
      const manager = new TestAgentHelmManager(
        new RelayerConfigHelper(partialConfig),
        Role.Relayer,
      );

      let rejection: unknown;
      try {
        await manager.helmValues();
      } catch (error) {
        rejection = error;
      }
      expect(rejection).to.be.instanceOf(Error);
      if (rejection instanceof Error) {
        expect(rejection.message).to.equal(
          'fallbackHedgeDelayMillis and fallbackHedgeTimeoutMillis must be configured together',
        );
      }
    }
  });

  const environmentAgents = {
    mainnet3: mainnet3Agents,
    testnet4: testnet4Agents,
  };

  Object.entries(environmentAgents).forEach(([environment, agents]) => {
    it(`leaves ${environment} shared scraper connection headroom`, () => {
      const configuredClients = configuredScraperAgentClients(agents);
      const maxAgentClients =
        agents[Contexts.Hyperlane].scraperProxy?.maxAgentClients ?? 0;

      expect(
        maxAgentClients,
        `${configuredClients} configured or planned agent clients require 25% headroom`,
      ).to.be.at.least(Math.ceil(configuredClients * 1.25));
    });

    Object.entries(agents).forEach(([context, config]) => {
      const { relayer, validators } = config;
      if (validators) {
        it(`configures ${environment}/${context} validators for the shared scraper`, () => {
          expect(validators.websocketUrl).to.equal(
            `ws://scraper-proxy.${environment}.svc.cluster.local:8383/agents`,
          );
        });
      }

      if (relayer) {
        it(`configures ${environment}/${context} relayers for the shared scraper`, () => {
          expect(relayer.websocketUrl).to.equal(
            `ws://scraper-proxy.${environment}.svc.cluster.local:8383/agents`,
          );
          expect(
            relayer.websocketAuthorityEnabled,
            `${environment}/${context} shared scraper authority`,
          ).to.equal(
            // Keep RPC authority until seismictestnet scraper coverage and freshness are fixed.
            !(environment === 'testnet4' && context === Contexts.Hyperlane),
          );
        });
      }
    });
  });

  it('polls fastpath relayer indexes every two seconds', () => {
    expect(
      mainnet3Agents[Contexts.FastPath].relayer?.interval,
      'mainnet3 fastpath interval',
    ).to.equal(2);
    expect(
      testnet4Agents[Contexts.FastPath].relayer?.interval,
      'testnet4 fastpath interval',
    ).to.equal(2);
  });

  it('bounds release candidate relayer cold-start indexing', () => {
    expect(mainnet3Agents[Contexts.Hyperlane].relayer?.index?.from).to.be
      .undefined;
    expect(testnet4Agents[Contexts.Hyperlane].relayer?.index?.from).to.be
      .undefined;
    expect(
      mainnet3Agents[Contexts.ReleaseCandidate].relayer?.index?.from,
    ).to.equal(RELEASE_CANDIDATE_INDEX_FROM);
    expect(
      testnet4Agents[Contexts.ReleaseCandidate].relayer?.index?.from,
    ).to.equal(RELEASE_CANDIDATE_INDEX_FROM);
  });

  Object.entries(environmentChainConfigs).forEach(([environment, config]) => {
    describe(`Environment: ${environment}`, () => {
      // eslint-disable-next-line jest/expect-expect -- ensureAgentChainConfigIncludesAllChainNames throws on failure
      it('AgentChainConfig specifies all chains for each role in the agent chain config', () => {
        // This will throw if there are any inconsistencies
        ensureAgentChainConfigIncludesAllChainNames(
          config.agentChainConfig as AgentChainConfig<
            typeof config.supportedChainNames
          >,
          config.supportedChainNames,
        );
      });

      it('Agent JSON config matches environment chains', () => {
        const agentJsonConfigChains = Object.keys(
          config.agentJsonConfig.chains,
        );
        // Allow for the agent JSON config to be a superset of the supported
        // chain names, as AW may not always run agents for all chains.
        expect(agentJsonConfigChains).to.include.members(
          config.supportedChainNames,
        );
      });
    });
  });
});
