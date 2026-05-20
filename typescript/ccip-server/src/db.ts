import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { PrismaClient } from './generated/prisma/client.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });
