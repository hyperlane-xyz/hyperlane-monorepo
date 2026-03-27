import fs from 'node:fs';
import path from 'node:path';

import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

import {
  sortNestedArrays,
  sortObjectKeys,
  WARP_YAML_SORT_CONFIG,
} from '../typescript/utils/src/yaml.ts';

function getDefaultFiles(): string[] {
  const root = path.resolve('typescript/infra');
  const files: string[] = [];

  function hasIgnoredSegment(relativePath: string): boolean {
    const segments = relativePath.split(path.sep);
    return ['helm', 'node_modules', 'dist', 'rebalancer'].some((segment) =>
      segments.includes(segment),
    );
  }

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(process.cwd(), fullPath);

      if (entry.isDirectory()) {
        if (hasIgnoredSegment(relativePath)) {
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        files.push(relativePath);
      }
    }
  }

  walk(root);
  return files;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const files = args.filter((arg) => arg !== '--check');
const targetFiles = files.length > 0 ? files : getDefaultFiles();

if (targetFiles.length === 0) {
  console.log('No YAML files found.');
  process.exit(0);
}

let failed = false;

for (const file of targetFiles) {
  try {
    const content = fs.readFileSync(file, 'utf8');
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
  console.log(
    'Some YAML files are not sorted. Run: pnpm exec tsx ./scripts/sort-yaml.ts',
  );
  process.exit(1);
}
