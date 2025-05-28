import express from 'express';
import client from 'prom-client';

async function startPrometheusServer() {
  client.collectDefaultMetrics({
    prefix: 'offchain_lookup_server_',
  });

  const app = express();

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  });

  const port = parseInt(process.env.PROMETHEUS_PORT ?? '9090');
  app.listen(port, () =>
    console.log(`Prometheus server started on port ${port}`),
  );
}

export default startPrometheusServer;
