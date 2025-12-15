import fs from 'fs';
import { glob } from 'glob';
import path from 'path';

import { FunctionRegistry } from './function-registry.js';
import { Transformer } from './transformer.js';

/**
 * Solidity Named Arguments Converter
 *
 * A tool to automatically convert Solidity function calls to use named argument syntax.
 *
 * Example transformation:
 *   Before: dispatch(domain, recipient, body)
 *   After:  dispatch({destinationDomain: domain, recipientAddress: recipient, messageBody: body})
 */

export { FunctionRegistry } from './function-registry.js';
export { Transformer } from './transformer.js';

/**
 * Main converter class that orchestrates the conversion process
 */
export class NamedArgsConverter {
  constructor(options = {}) {
    this.options = {
      minArgs: options.minArgs || 1,
      dryRun: options.dryRun || false,
      verbose: options.verbose || false,
      write: options.write || false,
      excludePatterns: options.excludePatterns || [
        '**/node_modules/**',
        '**/lib/**',
      ],
      ...options,
    };

    this.registry = new FunctionRegistry();
    this.results = [];
  }

  /**
   * Convert a single file
   */
  async convertFile(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');

    // First, parse the file to register functions
    this.registry.parseFile(filePath, source);

    // Then transform
    const transformer = new Transformer(this.registry, this.options);
    const result = transformer.transform(source, filePath);

    // Write if not dry run and changes were made
    if (
      this.options.write &&
      !this.options.dryRun &&
      result.changes.length > 0
    ) {
      fs.writeFileSync(filePath, result.source, 'utf8');
    }

    this.results.push({
      filePath,
      changes: result.changes.length,
      details: result.changes,
      errors: result.errors,
    });

    return result;
  }

  /**
   * Convert all files in a directory
   *
   * Two-pass approach:
   * 1. First pass: Parse all files to build complete function registry
   * 2. Second pass: Transform all files using the complete registry
   */
  async convertDirectory(directory, pattern = '**/*.sol') {
    // Get all matching files
    const files = await glob(pattern, {
      cwd: directory,
      absolute: true,
      ignore: this.options.excludePatterns,
    });

    if (this.options.verbose) {
      console.log(`Found ${files.length} Solidity files`);
    }

    // First pass: Build complete registry
    console.log('Pass 1: Building function registry...');

    // Auto-detect and parse Foundry artifacts from out/ directory
    // This provides function definitions for all compiled contracts including external deps
    const outDir = path.join(directory, '..', 'out');
    if (fs.existsSync(outDir)) {
      const artifactCount = await this.registry.parseFoundryArtifacts(outDir);
      if (this.options.verbose) {
        console.log(`Loaded ${artifactCount} contracts from Foundry artifacts`);
      }
    }

    // Parse main target files
    for (const file of files) {
      try {
        const source = fs.readFileSync(file, 'utf8');
        this.registry.parseFile(file, source);
      } catch (error) {
        if (this.options.verbose) {
          console.error(`Error parsing ${file}:`, error.message);
        }
      }
    }

    const stats = this.registry.getStats();
    console.log(
      `Registry: ${stats.contracts} contracts, ${stats.functions} functions, ${stats.events} events, ${stats.errors} errors`,
    );

    // Second pass: Transform files
    console.log('Pass 2: Transforming function calls...');
    for (const file of files) {
      try {
        const source = fs.readFileSync(file, 'utf8');
        const transformer = new Transformer(this.registry, this.options);
        const result = transformer.transform(source, file);

        if (result.changes.length > 0) {
          if (this.options.verbose) {
            console.log(`${file}: ${result.changes.length} changes`);
          }

          if (this.options.write && !this.options.dryRun) {
            fs.writeFileSync(file, result.source, 'utf8');
          }
        }

        this.results.push({
          filePath: file,
          changes: result.changes.length,
          details: result.changes,
          errors: result.errors,
        });
      } catch (error) {
        if (this.options.verbose) {
          console.error(`Error transforming ${file}:`, error.message);
        }
        this.results.push({
          filePath: file,
          changes: 0,
          errors: [error.message],
        });
      }
    }

    return this.getSummary();
  }

  /**
   * Get a summary of all conversions
   */
  getSummary() {
    const totalFiles = this.results.length;
    const filesChanged = this.results.filter((r) => r.changes > 0).length;
    const totalChanges = this.results.reduce((sum, r) => sum + r.changes, 0);
    const totalErrors = this.results.reduce(
      (sum, r) => sum + r.errors.length,
      0,
    );

    return {
      totalFiles,
      filesChanged,
      totalChanges,
      totalErrors,
      results: this.results,
    };
  }

  /**
   * Print a detailed report
   */
  printReport() {
    const summary = this.getSummary();

    console.log('\n=== Conversion Report ===');
    console.log(`Files scanned: ${summary.totalFiles}`);
    console.log(`Files with changes: ${summary.filesChanged}`);
    console.log(`Total function calls converted: ${summary.totalChanges}`);

    if (summary.totalErrors > 0) {
      console.log(`Errors: ${summary.totalErrors}`);
    }

    if (this.options.verbose && summary.filesChanged > 0) {
      console.log('\nFiles changed:');
      for (const result of this.results.filter((r) => r.changes > 0)) {
        console.log(`  ${result.filePath}: ${result.changes} changes`);
        if (result.details) {
          for (const change of result.details) {
            console.log(
              `    - ${change.funcName}() at line ${change.loc?.start?.line || '?'}`,
            );
          }
        }
      }
    }

    if (this.options.dryRun) {
      console.log('\n(Dry run - no files were modified)');
    }
  }
}

export default NamedArgsConverter;
