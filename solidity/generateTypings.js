import { glob, runTypeChain } from 'typechain';

async function main() {
  const cwd = process.cwd();
  // find all files matching the glob
  const allFiles = glob(cwd, [
    `!./artifacts-zk/!(build-info)/**/*.dbg.json`,
    `./artifacts-zk/!(build-info)/**/+([a-zA-Z0-9_]).json`,
  ]);

  const result = await runTypeChain({
    cwd,
    filesToProcess: allFiles,
    allFiles,
    outDir: './types',
    target: 'ethers-v5',
    flags: { node16Modules: true, alwaysGenerateOverloads: true },
  });

  console.log(result);
}

main().catch(console.error);
