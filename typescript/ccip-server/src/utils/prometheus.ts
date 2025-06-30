import express from 'express';
import { Counter, Registry } from 'prom-client';

// Global register for offchain lookup metrics
const register = new Registry();

const requestCounter = new Counter({
  name: 'hyperlane_offchain_lookup_server_http_requests',
  help: 'Total number of HTTP offchain lookup requests',
  labelNames: ['service', 'status_code'],
  registers: [register],
});

// TODO: eventually deprecate this metric, once we properly distinguish unhandled errors from handled errors
const unhandledErrorCounter = new Counter({
  name: 'hyperlane_offchain_lookup_server_unhandled_errors',
  help: 'Total number of unhandled errors',
  labelNames: ['service'],
  registers: [register],
});

export const PrometheusMetrics = {
  logLookupRequest(service: string, statusCode: number) {
    requestCounter.inc({ service, status_code: statusCode });
  },
  logUnhandledError(service: string) {
    unhandledErrorCounter.inc({ service });
  },
};

export async function startPrometheusServer() {
  const app = express();

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  const port = parseInt(process.env.PROMETHEUS_PORT ?? '9090');
  app.listen(port, () =>
    console.log(`Prometheus server started on port ${port}`),
  );
}
