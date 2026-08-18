import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import yargs from 'yargs';

import { fetchLatestGCPSecret } from '../../src/utils/gcloud.js';

const SCRAPER_READ_ONLY_DB_SECRET_NAME =
  'hyperlane-mainnet3-scraper3-db-read-only';
const DEFAULT_CONTAINER_NAME = 'scraper-prod-fork';
const DEFAULT_LOCAL_DATABASE = 'postgres';
const DEFAULT_POSTGRES_IMAGE = 'postgres:17';
const DEFAULT_LOCAL_PORT = 5432;
const DEFAULT_RESTORE_JOBS = 4;

type Args = {
  containerName: string;
  dumpFile: string;
  localDatabase: string;
  localPort: number;
  password: string;
  postgresImage: string;
  prodDatabaseUrl?: string;
  prodSchema: string;
  prodSecretName: string;
  refreshDump: boolean;
  replace: boolean;
  restoreJobs: number;
  skipDump: boolean;
  skipProdIndexes: boolean;
  skipMigrations: boolean;
};

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function run(
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    redactions?: readonly string[];
    sensitive?: boolean;
  },
) {
  const printableArgs = options?.sensitive
    ? ['<redacted>']
    : args.map((arg) =>
        (options?.redactions ?? []).reduce(
          (redacted, secret) => redacted.replaceAll(secret, '<redacted>'),
          arg,
        ),
      );
  console.log(`$ ${[command, ...printableArgs].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
    stdio: 'inherit',
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${command} failed${result.error ? `: ${result.error.message}` : ''}`,
    );
  }
}

function dockerContainerExists(containerName: string): boolean {
  const result = spawnSync('docker', ['container', 'inspect', containerName], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function startPostgres(args: Args) {
  if (dockerContainerExists(args.containerName)) {
    if (!args.replace) {
      throw new Error(
        `Docker container ${args.containerName} already exists. Re-run with --replace to recreate it.`,
      );
    }
    run('docker', ['rm', '-f', '-v', args.containerName]);
  }

  run(
    'docker',
    [
      'run',
      '--name',
      args.containerName,
      '-e',
      `POSTGRES_PASSWORD=${args.password}`,
      '-e',
      `POSTGRES_DB=${args.localDatabase}`,
      '-p',
      `127.0.0.1:${args.localPort}:5432`,
      '-d',
      args.postgresImage,
    ],
    { redactions: [args.password] },
  );

  waitForPostgres(args.containerName);
}

function waitForPostgres(containerName: string) {
  for (let i = 0; i < 60; i++) {
    const result = spawnSync(
      'docker',
      ['exec', containerName, 'pg_isready', '-U', 'postgres'],
      { stdio: 'ignore' },
    );
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`Postgres container ${containerName} did not become ready`);
}

function postgresEnvFromUrl(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  return {
    PGDATABASE: url.pathname.replace(/^\//, ''),
    PGHOST: url.hostname,
    PGPASSWORD: decodeURIComponent(url.password),
    PGPORT: url.port || '5432',
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'require',
    PGUSER: decodeURIComponent(url.username),
  };
}

async function getProdDatabaseUrl(args: Args): Promise<string> {
  if (args.prodDatabaseUrl) return args.prodDatabaseUrl;
  if (process.env.PROD_DATABASE_URL) return process.env.PROD_DATABASE_URL;
  return fetchLatestGCPSecret(args.prodSecretName);
}

async function dumpProdDatabase(args: Args) {
  if (existsSync(args.dumpFile) && !args.refreshDump) {
    console.log(
      `Reusing existing dump ${args.dumpFile}. Use --refreshDump to download it again.`,
    );
    return;
  }

  const prodDatabaseUrl = await getProdDatabaseUrl(args);
  mkdirSync(dirname(args.dumpFile), { recursive: true });
  const tmpDumpFile = `${args.dumpFile}.tmp-${process.pid}`;
  rmSync(tmpDumpFile, { force: true });

  run(
    'pg_dump',
    [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--serializable-deferrable',
      '--verbose',
      '--schema',
      args.prodSchema,
      '--file',
      tmpDumpFile,
    ],
    {
      env: postgresEnvFromUrl(prodDatabaseUrl),
      sensitive: true,
    },
  );
  renameSync(tmpDumpFile, args.dumpFile);
}

function localDatabaseUrl(args: Args): string {
  return `postgresql://postgres:${args.password}@127.0.0.1:${args.localPort}/${args.localDatabase}`;
}

function restoreLocalDatabase(args: Args) {
  const sectionArgs = args.skipProdIndexes
    ? ['--section', 'pre-data', '--section', 'data']
    : [];
  const parallelArgs = args.skipProdIndexes
    ? []
    : ['--jobs', args.restoreJobs.toString()];

  run(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      ...parallelArgs,
      '--no-owner',
      '--no-acl',
      '--verbose',
      ...sectionArgs,
      '--dbname',
      localDatabaseUrl(args),
      args.dumpFile,
    ],
    { redactions: [args.password] },
  );
}

function createFastLocalIndexes(args: Args) {
  run(
    'psql',
    [
      localDatabaseUrl(args),
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `
      CREATE UNIQUE INDEX IF NOT EXISTS local_outbox_domain_id_idx ON domain (id);
      CREATE UNIQUE INDEX IF NOT EXISTS local_outbox_block_id_idx ON block (id);
      CREATE INDEX IF NOT EXISTS local_outbox_block_domain_height_idx ON block (domain, height);
      CREATE UNIQUE INDEX IF NOT EXISTS local_outbox_transaction_id_idx ON transaction (id);
      CREATE INDEX IF NOT EXISTS local_outbox_transaction_block_idx ON transaction (block_id);
      CREATE INDEX IF NOT EXISTS local_outbox_message_origin_tx_id_idx ON message (origin_tx_id);
      CREATE INDEX IF NOT EXISTS local_outbox_delivered_message_tx_idx ON delivered_message (destination_tx_id);
      CREATE INDEX IF NOT EXISTS local_outbox_gas_payment_tx_id_idx ON gas_payment (tx_id);
      `,
    ],
    { redactions: [args.password] },
  );
}

function runMigrations(args: Args) {
  run('cargo', ['run', '--package', 'migration', '--bin', 'init-db'], {
    cwd: resolve(repoRoot(), 'rust/main'),
    env: {
      DATABASE_URL: localDatabaseUrl(args),
    },
  });
}

function redactedLocalDatabaseUrl(args: Args): string {
  return localDatabaseUrl(args).replace(args.password, '<password>');
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const cliArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const args = await yargs(cliArgs)
    .scriptName('pnpm -C typescript/infra fork-scraper-db --')
    .usage(
      '$0 --password <local-password> [--replace] [--refreshDump]\n\nFork the production scraper Postgres DB into a local Docker Postgres on localhost:5432. Reuses the local dump file by default when it already exists.',
    )
    .example(
      '$0 --password test --replace',
      'Create/recreate the local DB, reusing the existing dump if present.',
    )
    .example(
      '$0 --password test --replace --refreshDump',
      'Download a fresh prod dump before restoring locally.',
    )
    .example(
      '$0 --password test --localPort 5433 --dumpFile /tmp/scraper.dump',
      'Use a custom local port and dump path.',
    )
    .option('containerName', {
      default: DEFAULT_CONTAINER_NAME,
      description: 'Local Docker container name.',
      type: 'string',
    })
    .option('dumpFile', {
      default: '/tmp/hyperlane-scraper-prod-fork.dump',
      description:
        'Local pg_dump file. Reused by default if it already exists.',
      type: 'string',
    })
    .option('localDatabase', {
      default: DEFAULT_LOCAL_DATABASE,
      description: 'Local Postgres database name.',
      type: 'string',
    })
    .option('localPort', {
      default: DEFAULT_LOCAL_PORT,
      description: 'Local host port to expose Postgres on.',
      type: 'number',
    })
    .option('password', {
      demandOption: true,
      description: 'Password for the local Docker Postgres user.',
      type: 'string',
    })
    .option('postgresImage', {
      default: DEFAULT_POSTGRES_IMAGE,
      description: 'Docker Postgres image to run locally.',
      type: 'string',
    })
    .option('prodDatabaseUrl', {
      description:
        'Production scraper DB URL. Prefer PROD_DATABASE_URL env var or Secret Manager.',
      type: 'string',
    })
    .option('prodSecretName', {
      default: SCRAPER_READ_ONLY_DB_SECRET_NAME,
      description:
        'GCP Secret Manager secret containing the prod read-only DB URL.',
      type: 'string',
    })
    .option('prodSchema', {
      default: 'public',
      description:
        'Production DB schema to dump. Defaults to public to avoid Hasura hdb_catalog permissions.',
      type: 'string',
    })
    .option('replace', {
      default: false,
      description:
        'Delete and recreate the local Docker container/volume if it already exists.',
      type: 'boolean',
    })
    .option('refreshDump', {
      default: false,
      description:
        'Download a fresh prod dump even when --dumpFile already exists.',
      type: 'boolean',
    })
    .option('restoreJobs', {
      default: DEFAULT_RESTORE_JOBS,
      description:
        'Parallel pg_restore jobs. Higher is faster but uses more local CPU and disk IO.',
      type: 'number',
    })
    .option('skipDump', {
      default: false,
      description:
        'Do not download or check the dump file; restore from --dumpFile directly.',
      type: 'boolean',
    })
    .option('skipProdIndexes', {
      default: false,
      description:
        'Restore only schema/data from prod, skip prod indexes/FKs/triggers, then create minimal local unique keys/indexes for migrations and outbox testing.',
      type: 'boolean',
    })
    .option('skipMigrations', {
      default: false,
      description: 'Restore only; do not run scraper migrations afterward.',
      type: 'boolean',
    })
    .wrap(null)
    .strict()
    .parse();

  startPostgres(args);
  if (!args.skipDump) {
    await dumpProdDatabase(args);
  }
  restoreLocalDatabase(args);
  if (args.skipProdIndexes) {
    createFastLocalIndexes(args);
  }
  if (!args.skipMigrations) {
    runMigrations(args);
  }

  console.log(`Local scraper DB: ${redactedLocalDatabaseUrl(args)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
