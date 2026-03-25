/* eslint-disable no-console */

import { HyperlaneJsonRpcProvider } from '../src/providers/SmartProvider/HyperlaneJsonRpcProvider.js';
import { ProviderMethod } from '../src/providers/SmartProvider/ProviderMethods.js';
import { HyperlaneSmartProvider } from '../src/providers/SmartProvider/SmartProvider.js';
import {
  SMART_PROVIDER_REQUEST_CONFIG,
  SmartProviderRequestConfig,
} from '../src/providers/SmartProvider/types.js';

const TEST_ADDRESS = '0x0000000000000000000000000000000000000001';

type Scenario = 'empty_response' | 'server_then_empty';

class BenchmarkJsonRpcProvider extends HyperlaneJsonRpcProvider {
  constructor(
    private readonly scenario: Scenario,
    private readonly index: number,
    private readonly delayMs = 0,
  ) {
    super(
      { http: `http://benchmark-${scenario}-${index}` },
      { chainId: 1, name: 'benchmark' },
    );
  }

  override async perform(method: string, params: any): Promise<any> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const requestConfig: SmartProviderRequestConfig | undefined =
      params?.[SMART_PROVIDER_REQUEST_CONFIG];

    if (method !== ProviderMethod.Call) {
      return super.perform(method, params);
    }

    if (this.scenario === 'server_then_empty' && this.index === 0) {
      throw Object.assign(new Error('connection refused'), {
        code: 'SERVER_ERROR',
      });
    }

    if (requestConfig?.allowEmptyCallResult) {
      return '0x';
    }

    throw new Error('Invalid response from provider');
  }
}

class BenchmarkSmartProvider extends HyperlaneSmartProvider {
  constructor(rpcProviders: BenchmarkJsonRpcProvider[]) {
    super(
      { chainId: 1, name: 'benchmark' },
      [{ http: 'http://placeholder' }],
      [],
      {
        maxRetries: 3,
        baseRetryDelayMs: 10,
        fallbackStaggerMs: 25,
      },
    );

    (this as any).explorerProviders = [];
    (this as any).rpcProviders = rpcProviders;
    (this as any).supportedMethods = [ProviderMethod.Call];
  }

  async runReadCall(): Promise<void> {
    try {
      await this.perform(ProviderMethod.Call, {
        transaction: { to: TEST_ADDRESS },
        blockTag: 'latest',
      });
    } catch (error) {
      void error;
    }
  }

  async runProbeCall(): Promise<void> {
    try {
      await this.probeCall({ to: TEST_ADDRESS });
    } catch (error) {
      void error;
    }
  }
}

async function benchmark(
  run: () => Promise<void>,
  iterations = 20,
): Promise<{ avgMs: number; minMs: number; maxMs: number }> {
  const times: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }

  const total = times.reduce((sum, value) => sum + value, 0);
  return {
    avgMs: total / times.length,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

async function runScenario(
  scenario: Scenario,
  providerCount: number,
): Promise<void> {
  const buildProviders = () =>
    Array.from({ length: providerCount }, (_, index) => {
      return new BenchmarkJsonRpcProvider(scenario, index);
    });

  const readProvider = new BenchmarkSmartProvider(buildProviders());
  const probeProvider = new BenchmarkSmartProvider(buildProviders());

  const [readResult, probeResult] = await Promise.all([
    benchmark(() => readProvider.runReadCall()),
    benchmark(() => probeProvider.runProbeCall()),
  ]);

  const speedup = readResult.avgMs / probeResult.avgMs;
  console.log(`\nScenario: ${scenario}`);
  console.log(
    `  read  avg=${formatMs(readResult.avgMs)} min=${formatMs(readResult.minMs)} max=${formatMs(readResult.maxMs)}`,
  );
  console.log(
    `  probe avg=${formatMs(probeResult.avgMs)} min=${formatMs(probeResult.minMs)} max=${formatMs(probeResult.maxMs)}`,
  );
  console.log(`  speedup=${speedup.toFixed(2)}x`);
}

async function main(): Promise<void> {
  console.log(
    'Synthetic SmartProvider probe benchmark. Measures retry-policy overhead only.',
  );

  await runScenario('empty_response', 1);

  await runScenario('server_then_empty', 2);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
