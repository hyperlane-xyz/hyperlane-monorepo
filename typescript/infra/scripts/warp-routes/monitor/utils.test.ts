export function parseRoute(input: string): { service: string; version: string; path: string } | null {
  if (!input) {
    return null;
  }
  const parts = input.split('/');
  if (parts.length === 5 && parts[1] === 'svc') {
    const [, , service, version, path] = parts;
    if (service && version && path) {
      return { service, version, path };
    }
  }
  return null;
}

export function buildEventMessage(
  routeObj: { service: string; version: string; path: string },
  status: number,
  latencyMs: number,
): { timestamp: string; service: string; route: string; status: number; latencyMs: number } {
  return {
    timestamp: new Date().toISOString(),
    service: routeObj.service,
    route: routeObj.path,
    status,
    latencyMs,
  };
}

export function filterInvalidRecords<T extends { status?: number; latencyMs?: number }>(
  records: T[],
): T[] {
  return records.filter(
    (r): r is T & { status: number; latencyMs: number } =>
      typeof r.status === 'number' && typeof r.latencyMs === 'number',
  );
}

export function groupByService<T extends { service: string }>(
  routes: T[],
): Record<string, T[]> {
  return routes.reduce<Record<string, T[]>>((acc, route) => {
    const { service } = route;
    if (!acc[service]) {
      acc[service] = [];
    }
    acc[service].push(route);
    return acc;
  }, {});
}