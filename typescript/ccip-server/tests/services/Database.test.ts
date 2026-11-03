import { expect } from 'chai';
import pg from 'pg';
import sinon from 'sinon';

import { createPrismaClient } from '../../src/db.js';

describe('database lifecycle', () => {
  it('disposes the externally owned pool on disconnect', async () => {
    const pool = new pg.Pool();
    const end = sinon.spy(pool, 'end');
    const prisma = createPrismaClient(pool);

    await prisma.$connect();
    await prisma.$disconnect();

    expect(end.callCount).to.equal(1);
  });
});
