import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { expect } from 'chai';
import { parse as parseYaml } from 'yaml';
import { RebalancerConfigSchema } from '@hyperlane-xyz/rebalancer/config';

import { environments } from '../config/environments/index.js';
import { CCTP_CHAINS } from '../config/environments/mainnet3/warp/configGetters/getCCTPConfig.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('Rebalancer Configuration', () => {
  describe('Funding configuration for mainnet3', () => {
    it('should have desired rebalancer balance settings for all mainnet CCTP warp route chains', () => {
      const env = environments.mainnet3;
      expect(env.keyFunderConfig).to.not.be.undefined;
      const rebalancerBalances =
        env.keyFunderConfig!.desiredRebalancerBalancePerChain;

      // Check that all CCTP chains have rebalancer balance settings
      for (const chain of CCTP_CHAINS) {
        expect(
          rebalancerBalances[chain],
          `Missing rebalancer balance for CCTP chain ${chain}. All chains in the mainnet CCTP warp route should have desired rebalancer balance settings.`,
        ).to.not.be.undefined;

        // Also verify it's a valid numeric string
        expect(
          parseFloat(rebalancerBalances[chain]),
          `Invalid rebalancer balance for chain ${chain}: ${rebalancerBalances[chain]}`,
        ).to.be.a('number');
      }
    });
  });
});

describe('Rebalancer YAML config schema validation', () => {
  it('all rebalancer YAML configs should satisfy RebalancerConfigSchema', () => {
    function getYamlFiles(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries.flatMap((entry) => {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) return getYamlFiles(fullPath);
        if (entry.name.endsWith('.yaml')) return [fullPath];
        return [];
      });
    }

    const configDir = resolve(
      __dirname,
      '../config/environments/mainnet3/rebalancer',
    );
    const yamlFiles = getYamlFiles(configDir);
    expect(yamlFiles.length).to.be.greaterThan(0);

    for (const filePath of yamlFiles) {
      const raw = parseYaml(readFileSync(filePath, 'utf8'));
      const result = RebalancerConfigSchema.safeParse(raw);
      expect(
        result.success,
        `Config ${filePath} failed schema validation: ${!result.success ? JSON.stringify(result.error.issues) : ''}`,
      ).to.be.true;
    }
  });
});
