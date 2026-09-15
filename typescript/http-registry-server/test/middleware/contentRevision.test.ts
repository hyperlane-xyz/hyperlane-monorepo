import { expect } from 'chai';
import express from 'express';
import { createHash } from 'node:crypto';
import request from 'supertest';

import { registryContentRevision } from '../../src/middleware/contentRevision.js';

describe('registryContentRevision', () => {
  it('hashes the exact JSON bytes after Express serialization settings', async () => {
    const app = express();
    app.set('json spaces', 2);
    app.set('json escape', true);
    app.use(registryContentRevision());
    app.get('/metadata', (_req, res) => res.json({ name: '<chain>' }));

    const response = await request(app).get('/metadata').expect(200);
    const revision = createHash('sha256')
      .update(response.text)
      .digest('base64url');
    expect(response.headers.etag).to.equal(`"sha256-${revision}"`);
    expect(response.headers['x-hyperlane-registry-content-revision']).to.equal(
      revision,
    );
    await request(app)
      .get('/metadata')
      .set('If-None-Match', response.headers.etag)
      .expect(304);
    const head = await request(app).head('/metadata').expect(200);
    expect(head.headers.etag).to.equal(response.headers.etag);
  });

  it('serializes a stateful JSON value only once', async () => {
    const app = express();
    app.use(registryContentRevision());
    let serializations = 0;
    app.get('/metadata', (_req, res) =>
      res.json({ toJSON: () => ++serializations }),
    );

    const response = await request(app).get('/metadata').expect(200);
    const revision = createHash('sha256')
      .update(response.text)
      .digest('base64url');
    expect(serializations).to.equal(1);
    expect(response.headers.etag).to.equal(`"sha256-${revision}"`);
  });

  it('leaves signer, health, write, and error responses outside the revision policy', async () => {
    const app = express();
    app.use(registryContentRevision());
    app.get('/signer/account/test', (_req, res) =>
      res.json({ account: 'test' }),
    );
    app.get('/health', (_req, res) => res.json({ healthy: true }));
    app.post('/metadata', (_req, res) => res.json({ updated: true }));
    app.get('/metadata', (_req, res) =>
      res.status(500).json({ error: 'unavailable' }),
    );

    const responses = await Promise.all([
      request(app).get('/SIGNER/account/test').expect(200),
      request(app).get('/HEALTH/').expect(200),
      request(app).post('/metadata').expect(200),
      request(app).get('/metadata').expect(500),
    ]);
    for (const response of responses) {
      expect(response.headers['x-hyperlane-registry-content-revision']).to.be
        .undefined;
      expect(response.headers['cache-control']).to.be.undefined;
    }
  });
});
