import { isNullish, retryAsync, rootLogger } from '@hyperlane-xyz/utils';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import {
  type SurfpoolDatasource,
  SurfpoolDatasourceMode,
  type SurfpoolNode,
  type SurfpoolNodeConfig,
  buildSurfpoolArgs,
  buildSurfpoolDatasourceEnv,
  waitForSolanaRpcReady,
} from '../fork/surfpool-node.js';

const logger = rootLogger.child({ module: 'surfpool-container' });

export const SURFPOOL_IMAGE = 'surfpool/surfpool:1.5.0';

const DOCKER_INTERNAL_HOST = 'host.docker.internal';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);

// A datasource pointing at the host loopback is unreachable from inside a
// container; rewrite it so the containerized node can reach the host service.
function rewriteDatasourceForDocker(
  datasource: SurfpoolDatasource,
): SurfpoolDatasource {
  if (datasource.mode !== SurfpoolDatasourceMode.Fork) {
    return datasource;
  }

  const url = new URL(datasource.rpcUrl);
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return datasource;
  }

  url.hostname = DOCKER_INTERNAL_HOST;
  return { mode: SurfpoolDatasourceMode.Fork, rpcUrl: url.toString() };
}

/**
 * Starts a surfpool node in a Docker container via testcontainers. Test-only:
 * this module (and its `testcontainers` dependency) must never be reachable
 * from the `@hyperlane-xyz/sealevel-sdk/fork` production entrypoint.
 */
export async function runSurfpoolContainer(
  config: SurfpoolNodeConfig,
): Promise<SurfpoolNode> {
  const image = config.image ?? SURFPOOL_IMAGE;
  const datasource = rewriteDatasourceForDocker(config.datasource);
  const command = buildSurfpoolArgs(config, datasource, '0.0.0.0');
  const datasourceEnv = buildSurfpoolDatasourceEnv(datasource);

  const exposedPorts = [config.rpcPort];
  if (!isNullish(config.wsPort)) {
    exposedPorts.push(config.wsPort);
  }

  const builder = new GenericContainer(image)
    .withEntrypoint(['surfpool'])
    .withCommand(command)
    .withEnvironment(datasourceEnv)
    .withExposedPorts(...exposedPorts)
    .withExtraHosts([{ host: DOCKER_INTERNAL_HOST, ipAddress: 'host-gateway' }])
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000);

  const container: StartedTestContainer = await retryAsync(
    () => builder.start(),
    3,
    5000,
  );

  const rpcUrl = `http://${container.getHost()}:${container.getMappedPort(config.rpcPort)}`;

  const node: SurfpoolNode = {
    rpcUrl,
    kill() {
      if (config.keepRunning) {
        return;
      }
      void container.stop().catch((error) => {
        logger.debug({ err: error }, 'surfpool container stop failed');
      });
    },
  };

  await stopContainerOnReadinessFailure(container, node.rpcUrl);
  return node;
}

/**
 * Waits for the container's RPC to become ready, stopping the (already-started)
 * container if it never does. Without this, a readiness failure drops the only
 * handle to the started container and leaves surfpool running, contaminating
 * later local/e2e runs. The readiness probe is injectable for testing.
 */
export async function stopContainerOnReadinessFailure(
  container: { stop: () => Promise<unknown> },
  rpcUrl: string,
  waitForReady: (url: string) => Promise<void> = waitForSolanaRpcReady,
): Promise<void> {
  try {
    await waitForReady(rpcUrl);
  } catch (error: unknown) {
    await container
      .stop()
      .catch((stopError: unknown) =>
        logger.debug(
          { err: stopError },
          'surfpool container stop failed after readiness failure',
        ),
      );
    throw error;
  }
}
