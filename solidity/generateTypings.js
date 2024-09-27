import { glob, runTypeChain } from 'typechain';

async function main() {
  const cwd = process.cwd();
  // find all files matching the glob
  const allFiles = glob(cwd, [
    `!./artifacts/!(build-info)/**/*.dbg.json`,
    `./artifacts/!(build-info)/**/+([a-zA-Z0-9_]).json`,
  ]);

  const result = await runTypeChain({
    cwd,
    filesToProcess: allFiles,
    allFiles,
    outDir: './types',
    target: 'ethers-v5',

    flags: {
      node16Modules: true,
      alwaysGenerateOverloads: true,
    },
  });
  console.log(result);
}

main().catch(console.error);
