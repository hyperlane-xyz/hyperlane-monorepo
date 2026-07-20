import chalk from 'chalk';

import { checkWarpDeployConfig } from '../../config/environments/mainnet3/warp/checkWarpDeploy.js';
import { getArgs } from '../agent-utils.js';

import { warpViolationGroupings } from './check-utils.js';
import { deleteViolationSeriesOrThrow } from './clear-utils.js';
import { ownerStatusClearTargets } from './owner-status-skip.js';

// One-time rollout clear for the legacy-EOA ownerStatus allowlist.
//
// Adding a route to OWNER_STATUS_SKIP only stops the checker from refreshing the
// matching violation; a series already firing at 1 in PushGateway is never
// touched by the checker (by design — see pushWarpViolationsMetrics), so it would
// stay firing forever. This script deletes exactly the series that the allowlist
// now suppresses, derived from OWNER_STATUS_SKIP so the two can never drift.
// Idempotent: deleting an already-absent series is a no-op.
//
// This is not wired into the check-warp-deploy CronJob — it is a manual one-shot
// run at rollout, executed once after this filter merges. The chart deploys a
// CronJob (no long-lived pod to `kubectl exec` into), so launch a Job reusing
// the CronJob's image, PushGateway env, and secret:
//   NS=mainnet3
//   IMAGE=$(kubectl -n $NS get cronjob check-warp-deploy \
//     -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].image}')
//   PGW=$(kubectl -n $NS get cronjob check-warp-deploy -o jsonpath=\
//     '{.spec.jobTemplate.spec.template.spec.containers[0].env[?(@.name=="PROMETHEUS_PUSH_GATEWAY")].value}')
//   kubectl -n $NS apply -f - <<EOF
//   apiVersion: batch/v1
//   kind: Job
//   metadata: { name: clear-skipped-owner-status }
//   spec:
//     backoffLimit: 0
//     template:
//       spec:
//         restartPolicy: Never
//         containers:
//         - name: clear-skipped-owner-status
//           image: $IMAGE
//           # `args` (not `command`) preserves docker-entrypoint.sh, which pins
//           # the registry commit; mirrors the CronJob container invocation.
//           args: [pnpm, exec, tsx,
//             ./typescript/infra/scripts/check/clear-skipped-owner-status.ts,
//             -e, mainnet3]
//           env: [{ name: PROMETHEUS_PUSH_GATEWAY, value: "$PGW" }]
//           envFrom: [{ secretRef: { name: check-warp-deploy-env-var-secret } }]
//   EOF
//   kubectl -n $NS logs -f job/clear-skipped-owner-status
// Verify each target series is gone (via Prometheus or the gateway's /metrics).
// pushWarpViolationsMetrics always sets module="warp" and stores the module path
// in `contract_name`, so the selector is:
//   hyperlane_check_violations{module="warp",warp_route_id="<id>",chain="<chain>",
//     contract_name="ownerStatus.<owner>",type="ConfigMismatch"}
// must return no series for every OWNER_STATUS_SKIP entry.
// Exits non-zero if any DELETE is not confirmed by the gateway.
async function main() {
  const { environment, pushGateway } = await getArgs()
    .describe(
      'pushGateway',
      'PushGateway address; defaults to PROMETHEUS_PUSH_GATEWAY or the env config',
    )
    .string('pushGateway').argv;

  const gatewayAddr =
    pushGateway ??
    process.env['PROMETHEUS_PUSH_GATEWAY'] ??
    checkWarpDeployConfig.prometheusPushGateway;
  process.env['PROMETHEUS_PUSH_GATEWAY'] = gatewayAddr;

  const targets = ownerStatusClearTargets();
  console.log(
    chalk.yellow(
      `Clearing ${targets.length} skipped ownerStatus series via ${gatewayAddr}`,
    ),
  );

  const jobName = `check-warp-deploy-${environment}`;
  let cleared = 0;
  const failures: string[] = [];
  for (const [
    i,
    { warpRouteId, chain, contractName, violationType },
  ] of targets.entries()) {
    const groupings = warpViolationGroupings(
      warpRouteId,
      chain,
      contractName,
      violationType,
    );
    const label = `${violationType} ${warpRouteId} ${chain} "${contractName}"`;
    console.log(chalk.yellow(`[${i + 1}/${targets.length}] ${label}`));
    try {
      await deleteViolationSeriesOrThrow(jobName, groupings);
      cleared++;
    } catch (e) {
      failures.push(label);
      console.error(chalk.red(`  failed: ${e}`));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Cleared ${cleared}/${targets.length}; ${failures.length} failed:\n  ${failures.join('\n  ')}`,
    );
  }
  console.log(chalk.green(`Cleared ${cleared} series`));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
