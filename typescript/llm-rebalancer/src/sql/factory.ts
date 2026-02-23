import { URL } from 'node:url';

import type { SqlAdapter } from './SqlAdapter.js';
import { PostgresAdapter } from './PostgresAdapter.js';
import { SqliteAdapter } from './SqliteAdapter.js';

export async function createSqlAdapter(dbUrl: string): Promise<SqlAdapter> {
  if (dbUrl.startsWith('sqlite://')) {
    const filePath = dbUrl.replace('sqlite://', '');
    return new SqliteAdapter(filePath || ':memory:');
  }

  if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
    return PostgresAdapter.fromConnectionString(dbUrl);
  }

  const parsed = new URL(dbUrl);
  throw new Error(`Unsupported DB URL protocol: ${parsed.protocol}`);
}
