import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { PrismaClient } from './generated/prisma/client.js';

export function createPrismaClient(pool: pg.Pool): PrismaClient {
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return new PrismaClient({ adapter });
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const prisma = createPrismaClient(pool);
