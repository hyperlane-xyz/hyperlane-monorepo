import fs from 'node:fs';

import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

import {
  ArraySortConfig,
  sortNestedArrays,
} from '../typescript/utils/src/yaml.ts';

const WARP_YAML_SORT_CONFIG: ArraySortConfig = {
  arrays: [
    { path: 'tokens', sortKey: 'chainName' },
    { path: 'tokens[].connections', sortKey: 'token' },
    { path: '*.interchainSecurityModule.modules', sortKey: 'type' },
    {
      path: '*.interchainSecurityModule.modules[].domains.*.modules',
      sortKey: 'type',
    },
  ],
};

function sortObjectKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce(
        (sorted, key) => {
          sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
          return sorted;
        },
        {} as Record<string, unknown>,
      );
  }

  return obj;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const files = args.filter((arg) => arg !== '--check');

if (files.length === 0) {
  throw new Error('Usage: sort-yaml.ts [--check] <file...>');
}

let failed = false;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');

  try {
    const parsed = yamlParse(content);
    const sorted = yamlStringify(
      sortObjectKeys(sortNestedArrays(parsed, WARP_YAML_SORT_CONFIG)),
      null,
      { singleQuote: true },
    );

    if (check) {
      if (content !== sorted) {
        console.log(`UNSORTED: ${file}`);
        failed = true;
      }
      continue;
    }

    fs.writeFileSync(file, sorted);
    console.log(`Sorted: ${file}`);
  } catch (error) {
    console.error(error);
    console.error(`Error sorting ${file}`);
    process.exit(1);
  }
}

if (failed) {
  console.log('');
  console.log('Some YAML files are not sorted. Run: ./scripts/sort-yaml.sh');
  process.exit(1);
}
