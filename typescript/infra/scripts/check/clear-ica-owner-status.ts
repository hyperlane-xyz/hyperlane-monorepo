import chalk from 'chalk';

import { WARP_ROUTE_CHECK_TYPE } from '@hyperlane-xyz/sdk';

import { checkWarpDeployConfig } from '../../config/environments/mainnet3/warp/checkWarpDeploy.js';
import { getArgs } from '../agent-utils.js';

import { warpViolationGroupings } from './check-utils.js';
import { deleteViolationSeriesOrThrow } from './clear-utils.js';

// One-time rollout clear for the governance-ICA ownerStatus false positive.
//
// A nonce-less / lazily-deployed governance ICA owner (Tron/AltVM) derives as
// Inactive, and the ownerStatus virtual check used to force expected=Active — a
// permanent ConfigMismatch. The inline resolver in expandWarpDeployConfig (see
// configUtils.ts) now clears that at the source: when an interchainAccount is
// supplied, an Inactive owner is accepted iff the leaf ICA derived from the
// route's Ethereum-leg owner matches the on-chain owner AND that origin owner is
// a Safe with threshold > 1. So the checker no longer refreshes this series.
//
// But a series already firing at 1 in PushGateway is never touched by the
// checker (by design — see pushWarpViolationsMetrics): omitting it on a later
// run leaves the stale sample firing forever. This deletes exactly the one
// currently-firing ICA series so the alert actually clears at rollout.
// Idempotent: deleting an already-absent series is a no-op.
//
// This is not wired into the check-warp-deploy CronJob — it is a manual one-shot
// run once after the resolver merges. The chart deploys a CronJob (no long-lived
// pod to `kubectl exec` into), so launch a Job reusing the CronJob's image,
// PushGateway env, and secret:
//   NS=mainnet3
//   IMAGE=$(kubectl -n $NS get cronjob check-warp-deploy \
//     -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].image}')
//   PGW=$(kubectl -n $NS get cronjob check-warp-deploy -o jsonpath=\
//     '{.spec.jobTemplate.spec.template.spec.containers[0].env[?(@.name=="PROMETHEUS_PUSH_GATEWAY")].value}')
//   kubectl -n $NS apply -f - <<EOF
//   apiVersion: batch/v1
//   kind: Job
//   metadata: { name: clear-ica-owner-status }
//   spec:
//     backoffLimit: 0
//     template:
//       spec:
//         restartPolicy: Never
//         containers:
//         - name: clear-ica-owner-status
//           image: $IMAGE
//           # `args` (not `command`) preserves docker-entrypoint.sh, which pins
//           # the registry commit; mirrors the CronJob container invocation.
//           args: [pnpm, exec, tsx,
//             ./typescript/infra/scripts/check/clear-ica-owner-status.ts,
//             -e, mainnet3]
//           env: [{ name: PROMETHEUS_PUSH_GATEWAY, value: "$PGW" }]
//           envFrom: [{ secretRef: { name: check-warp-deploy-env-var-secret } }]
//   EOF
//   kubectl -n $NS logs -f job/clear-ica-owner-status
// pushWarpViolationsMetrics always sets module="warp" and stores the module path
// in `contract_name`, so verify the series is gone with:
//   hyperlane_check_violations{module="warp",warp_route_id="USDT/eclipsemainnet",
//     chain="tron",contract_name="ownerStatus.0x74E009ed8f6d7BBEce015c8A1E7076084e8aEBA6",
//     type="ConfigMismatch"}
// must return no series.
// Exits non-zero if the DELETE is not confirmed by the gateway.

// The specific ICA ownerStatus series firing at rollout, matching the on-chain
// leaf ICA owner the resolver now accepts. Keyed by
// (warp_route_id, chain, contract_name=`ownerStatus.<owner>`, type).
const ICA_OWNER_STATUS_CLEAR_TARGETS = [
  {
    warpRouteId: 'USDT/eclipsemainnet',
    chain: 'tron',
    contractName: 'ownerStatus.0x74E009ed8f6d7BBEce015c8A1E7076084e8aEBA6',
    violationType: WARP_ROUTE_CHECK_TYPE,
  },
];

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

  const targets = ICA_OWNER_STATUS_CLEAR_TARGETS;
  console.log(
    chalk.yellow(
      `Clearing ${targets.length} ICA ownerStatus series via ${gatewayAddr}`,
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
