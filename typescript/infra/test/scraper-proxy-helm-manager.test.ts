import { expect } from 'chai';

import { Contexts } from '../config/contexts.js';
import { ScraperProxyHelmManager } from '../src/agents/index.js';
import type { RootAgentConfig } from '../src/config/agent/agent.js';
import { Role } from '../src/roles.js';

describe('ScraperProxyHelmManager', () => {
  const config: RootAgentConfig = {
    runEnv: 'mainnet3',
    namespace: 'mainnet3',
    context: Contexts.Hyperlane,
    rolesWithKeys: [],
    environmentChainNames: [],
    contextChainNames: {
      [Role.Validator]: [],
      [Role.Relayer]: [],
      [Role.Scraper]: [],
    },
    scraperProxy: {
      docker: {
        repo: 'ghcr.io/hyperlane-xyz/hyperlane-node-services',
        tag: 'test',
      },
      enabled: true,
      port: 8383,
      replicas: 2,
    },
  };

  it('generates an independent proxy-only Helm release', async () => {
    const manager = new ScraperProxyHelmManager(config);
    const values = await manager.helmValues();

    expect(manager.helmReleaseName).to.equal('scraper-proxy');
    expect(values.fullnameOverride).to.equal('scraper-proxy');
    expect(values.image).to.deep.equal({
      repository: 'ghcr.io/hyperlane-xyz/hyperlane-node-services',
      tag: 'test',
    });
    expect(values.hyperlane.chains).to.deep.equal([]);
    expect(values.hyperlane.scraper).to.equal(undefined);
    expect(values.hyperlane.scraperProxy).to.deep.equal({
      enabled: true,
      port: 8383,
      replicas: 2,
    });
  });

  it('restarts the Deployment and waits for its rollout', async () => {
    class TestScraperProxyHelmManager extends ScraperProxyHelmManager {
      readonly commands: string[] = [];

      protected override async runCommand(command: string): Promise<void> {
        this.commands.push(command);
      }
    }

    const manager = new TestScraperProxyHelmManager(config);

    await manager.restartDeployment();

    expect(manager.commands).to.deep.equal([
      'kubectl rollout restart deployment/scraper-proxy -n mainnet3',
      'kubectl rollout status deployment/scraper-proxy -n mainnet3 --timeout=180s',
    ]);
  });
});
