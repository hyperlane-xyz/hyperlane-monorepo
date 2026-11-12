import { Gauge, type Registry } from 'prom-client';

import { getActionHoldReason } from '../tracking/actionDiagnostics.js';
import type { RebalanceAction } from '../tracking/types.js';

const LABEL_NAMES = [
  'warp_route_id',
  'origin',
  'destination',
  'action_type',
  'hold_reason',
] as const;
type Labels = Record<(typeof LABEL_NAMES)[number], string>;

/** Collect directly from local state: RPC and Explorer failures cannot freeze action ages. */
export function registerActionMetrics(
  registry: Registry,
  warpRouteId: string,
  readActions: () => Promise<RebalanceAction[]>,
): void {
  for (const age of [true, false]) {
    const previous = new Map<string, Labels>();
    new Gauge({
      name: age
        ? 'hyperlane_rebalancer_oldest_inflight_action_age_seconds'
        : 'hyperlane_rebalancer_inflight_actions',
      help: age
        ? 'Oldest reserved action age in seconds; age never permits retry.'
        : 'Actions reserved pending source or destination reconciliation.',
      labelNames: [...LABEL_NAMES],
      registers: [registry],
      async collect() {
        const actions = await readActions();
        const groups = new Map<string, { labels: Labels; value: number }>();
        const now = Date.now();
        for (const action of actions) {
          if (action.status !== 'in_progress') continue;
          const labels: Labels = {
            warp_route_id: warpRouteId,
            origin: String(action.origin),
            destination: String(action.destination),
            action_type: action.type,
            hold_reason: getActionHoldReason(action),
          };
          const key = JSON.stringify(labels);
          const existing = groups.get(key);
          const value = age
            ? Math.max(
                existing?.value ?? 0,
                Math.max(0, now - action.createdAt) / 1_000,
              )
            : (existing?.value ?? 0) + 1;
          groups.set(key, { labels, value });
        }
        for (const [key, labels] of previous) {
          if (!groups.has(key)) this.set(labels, 0);
        }
        previous.clear();
        for (const [key, { labels, value }] of groups) {
          this.set(labels, value);
          previous.set(key, labels);
        }
      },
    });
  }
}
