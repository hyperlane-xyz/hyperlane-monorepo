import { CompilerOutputContract } from 'hardhat/types';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const EXCLUDE = [
  '.dbg',
  'test',
  'Test',
  'mock',
  'Mock',
  'interfaces',
  'libs',
  'Abstract',
  'Base',
  'Storage',
  'Versioned',
];
const REQUIRED_METHOD = 'PACKAGE_VERSION';

// https://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search
const walk = async (dirPath) =>
  Promise.all(
    await readdir(dirPath, { withFileTypes: true }).then((entries) =>
      entries.map((entry) => {
        const childPath = join(dirPath, entry.name);
        return entry.isDirectory() ? walk(childPath) : childPath;
      }),
    ),
  );

const artifacts = (await walk('artifacts/contracts')).flat(
  Number.POSITIVE_INFINITY,
);

const filtered = artifacts.filter((path) =>
  EXCLUDE.every((excluded) => !path.includes(excluded)),
);

const results = await Promise.all(
  filtered.map(async (path) => {
    const content = await readFile(path, 'utf-8');
    const compilerOutput: CompilerOutputContract = JSON.parse(content);
    return [
      path,
      compilerOutput.abi.some((elem) => elem.name === REQUIRED_METHOD),
    ];
  }),
);

const missing = results.filter(([, included]) => !included);

if (missing.length > 0) {
  console.error(
    `Missing ${REQUIRED_METHOD} method in the following contracts:`,
  );
  const contracts = missing.map(([path]) =>
    basename(path).replace('.json', ''),
  );
  console.error(contracts.map((contract) => ` - ${contract}`).join('\n'));
  process.exit(1);
}

console.log('All contracts have the required method');
