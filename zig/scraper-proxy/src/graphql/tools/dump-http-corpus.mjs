// Dumps the GraphQL requests of the parity HTTP corpus (Explorer/Nexus/agent
// queries, every table shape, errors) as JSON for raw_rows_test.zig's
// PostgreSQL differential (raw rows vs today's path on the same database).
//   node src/graphql/tools/dump-http-corpus.mjs <db> > /tmp/corpus.json   (db: parity fixture name)
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { ZIG_DIR } from '../../../parity/lib/servers.mjs';
import { httpCases } from '../../../parity/corpus/http.mjs';
import { graphqlErrorCases } from '../../../parity/corpus/graphql-errors.mjs';
import { loadSamples } from '../../../parity/corpus/samples.mjs';

const db = process.argv[2] ?? 'parity';
const fixtures = join(ZIG_DIR, 'parity/fixtures/db.sh');
const url = (name) => execFileSync(fixtures, ['url', name], { encoding: 'utf8' }).trim();
const samples = await loadSamples(url(`scraper_${db}`), url(`diagnostics_${db}`));

const out = [];
for (const c of [...httpCases(samples), ...graphqlErrorCases(samples)]) {
  const { method, path, body } = c.request;
  let params;
  if (method === 'POST' && path === '/graphql' && body && typeof body === 'object' && !Array.isArray(body)) {
    params = body;
  } else if (method === 'GET' && path.startsWith('/graphql?')) {
    const q = new URLSearchParams(path.slice('/graphql?'.length));
    params = { query: q.get('query') };
    try {
      if (q.has('variables')) params.variables = JSON.parse(q.get('variables'));
    } catch {
      continue; // malformed variables: rejected before execution
    }
    if (q.has('operationName')) params.operationName = q.get('operationName');
  }
  if (typeof params?.query !== 'string') continue;
  const variables = params.variables && typeof params.variables === 'object' && !Array.isArray(params.variables) ? params.variables : null;
  const operationName = typeof params.operationName === 'string' ? params.operationName : null;
  out.push({ name: `${c.group} / ${c.name}`, query: params.query, variables, operationName });
}
process.stdout.write(JSON.stringify(out));
process.stderr.write(`${out.length} GraphQL requests\n`);
