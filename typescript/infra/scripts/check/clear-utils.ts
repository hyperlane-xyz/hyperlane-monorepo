import { Registry } from 'prom-client';

import { getPushGateway } from '@hyperlane-xyz/metrics';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

// Shared PushGateway delete helper for the clear-* scripts.
//
// The library `deleteMetrics` swallows every gateway error (and any non-2xx
// status) and resolves void, so a caller cannot tell a real delete from a
// failed one — a wedged gateway would leave stale series firing while the
// script reports success. These clears are one-shot cleanups whose whole point
// is a verified removal, so this helper instead throws unless the gateway
// confirms the delete with a 2xx status. Callers must let the throw propagate
// (or record the failure) so the process exits non-zero.
export async function deleteViolationSeriesOrThrow(
  jobName: string,
  groupings: Record<string, string>,
): Promise<void> {
  const gateway = getPushGateway(new Registry(), rootLogger);
  assert(
    gateway,
    'PushGateway not configured (set PROMETHEUS_PUSH_GATEWAY); refusing to report a clear that did not happen',
  );

  const { resp } = await gateway.delete({ jobName, groupings });
  const statusCode =
    typeof resp === 'object' && resp !== null && 'statusCode' in resp
      ? (resp as { statusCode?: unknown }).statusCode
      : undefined;

  assert(
    typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300,
    `PushGateway DELETE for ${JSON.stringify(groupings)} did not succeed (status=${String(
      statusCode,
    )})`,
  );
}
