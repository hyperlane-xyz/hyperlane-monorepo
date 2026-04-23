import { Registry } from 'prom-client';
import { expect } from 'vitest';

import { startMetricsServer } from './server.js';

describe('startMetricsServer', () => {
  const originalPort = process.env['PROMETHEUS_PORT'];

  afterEach(() => {
    if (originalPort === undefined) {
      delete process.env['PROMETHEUS_PORT'];
    } else {
      process.env['PROMETHEUS_PORT'] = originalPort;
    }
  });

  it('throws for non-numeric PROMETHEUS_PORT values', () => {
    process.env['PROMETHEUS_PORT'] = '';

    expect(() => startMetricsServer(new Registry())).toThrow(
      /PROMETHEUS_PORT must contain only digits/i,
    );
  });

  it('throws for out-of-range PROMETHEUS_PORT values', () => {
    process.env['PROMETHEUS_PORT'] = '70000';

    expect(() => startMetricsServer(new Registry())).toThrow(
      /PROMETHEUS_PORT must be between 1 and 65535/i,
    );
  });
});
