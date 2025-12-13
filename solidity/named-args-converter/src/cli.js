#!/usr/bin/env node
/**
 * CLI for Solidity Named Arguments Converter
 *
 * Usage:
 *   solidity-named-args [options] <path>
 *
 * Examples:
 *   # Dry run on a single file
 *   solidity-named-args --dry-run ./contracts/MyContract.sol
 *
 *   # Convert all files in a directory
 *   solidity-named-args --write ./contracts/
 *
 *   # Only convert calls with 3+ arguments
 *   solidity-named-args --min-args 3 --write ./contracts/
 */
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { NamedArgsConverter } from './index.js';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options] <path>')
  .positional('path', {
    describe: 'Path to Solidity file or directory',
    type: 'string',
  })
  .option('write', {
    alias: 'w',
    type: 'boolean',
    description: 'Write changes to files (default: false)',
    default: false,
  })
  .option('dry-run', {
    alias: 'd',
    type: 'boolean',
    description: 'Show what would be changed without modifying files',
    default: false,
  })
  .option('min-args', {
    alias: 'm',
    type: 'number',
    description: 'Minimum number of arguments to require named parameters',
    default: 1,
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Show detailed output',
    default: false,
  })
  .option('pattern', {
    alias: 'p',
    type: 'string',
    description: 'Glob pattern for matching Solidity files',
    default: '**/*.sol',
  })
  .option('exclude', {
    alias: 'e',
    type: 'array',
    description: 'Patterns to exclude',
    default: ['**/node_modules/**', '**/lib/**', '**/forge-std/**'],
  })
  .option('show-diff', {
    type: 'boolean',
    description: 'Show diff of changes',
    default: false,
  })
  .option('json', {
    type: 'boolean',
    description: 'Output results as JSON',
    default: false,
  })
  .example(
    '$0 --dry-run ./contracts/',
    'Preview changes in contracts directory',
  )
  .example(
    '$0 --write -m 3 ./contracts/',
    'Convert calls with 3+ args and save',
  )
  .example(
    '$0 -v --show-diff ./contracts/Mailbox.sol',
    'Show detailed changes for a file',
  )
  .help('h')
  .alias('h', 'help')
  .version('1.0.0')
  .parse();

async function main() {
  const targetPath = argv._[0];

  if (!targetPath) {
    console.error(
      'Error: Please specify a path to a Solidity file or directory',
    );
    process.exit(1);
  }

  const absolutePath = path.resolve(targetPath);

  if (!fs.existsSync(absolutePath)) {
    console.error(`Error: Path does not exist: ${absolutePath}`);
    process.exit(1);
  }

  const isDirectory = fs.statSync(absolutePath).isDirectory();

  const converter = new NamedArgsConverter({
    minArgs: argv.minArgs,
    dryRun: argv.dryRun || !argv.write,
    verbose: argv.verbose,
    write: argv.write,
    excludePatterns: argv.exclude,
  });

  console.log('Solidity Named Arguments Converter');
  console.log('===================================');
  console.log(`Target: ${absolutePath}`);
  console.log(`Mode: ${argv.write ? 'Write' : 'Dry run'}`);
  console.log(`Min args: ${argv.minArgs}`);
  console.log('');

  let summary;

  if (isDirectory) {
    summary = await converter.convertDirectory(absolutePath, argv.pattern);
  } else {
    await converter.convertFile(absolutePath);
    summary = converter.getSummary();
  }

  if (argv.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    converter.printReport();

    // Show diffs if requested
    if (argv.showDiff && summary.totalChanges > 0) {
      console.log('\n=== Changes ===');
      for (const result of summary.results.filter((r) => r.changes > 0)) {
        console.log(`\nFile: ${result.filePath}`);
        console.log('-'.repeat(60));
        for (const change of result.details || []) {
          console.log(
            `Line ${change.loc?.start?.line || '?'}: ${change.funcName}`,
          );
          console.log(`  - ${change.original}`);
          console.log(`  + ${change.replacement}`);
        }
      }
    }
  }

  // Exit with error code if there were errors
  if (summary.totalErrors > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
