// Re-records a replay fixture from a live node:
//   RPC_URL=<node url> pnpm exec tsx src/test/fixtures/warp-route-replay/record.ts <scenario>
// RPC_URL is read from the environment only and never written to the fixture.
// eslint-disable-next-line import/no-nodejs-modules
import { writeFileSync } from 'fs';

import { assert } from '@hyperlane-xyz/utils';

import {
  REPLAY_FIXTURE_DIR,
  createReplayReader,
  serializeReplayFixture,
  startRecordingServer,
} from '../../replayRpc.js';
import { REPLAY_SCENARIOS, runProbe } from '../../replayScenarios.js';

const [scenarioName] = process.argv.slice(2);
const upstream = process.env.RPC_URL;
assert(upstream, 'RPC_URL is required');
const scenario = REPLAY_SCENARIOS.find((s) => s.scenario === scenarioName);
assert(scenario, `Unknown scenario ${scenarioName}`);

const recorder = await startRecordingServer(upstream, {
  scenario: scenario.scenario,
  chain: scenario.chain,
  chainId: scenario.chainId,
});
try {
  const { reader, provider } = createReplayReader(
    recorder.url,
    scenario.chainId,
  );
  const result = await scenario.run(reader, scenario.router);
  console.log(`${scenario.scenario}:`, result);
  for (const probe of scenario.probes) {
    await runProbe(provider, probe).catch((error: unknown) =>
      console.log(
        `probe ${probe.signature} threw: ${String(error).slice(0, 80)}`,
      ),
    );
  }
  assert(
    recorder.failures.length === 0,
    `Recording server failures: ${recorder.failures.join('; ')}`,
  );
  writeFileSync(
    new URL(`${scenario.scenario}.json`, REPLAY_FIXTURE_DIR),
    serializeReplayFixture(recorder.fixture),
  );
} finally {
  await recorder.close();
}
