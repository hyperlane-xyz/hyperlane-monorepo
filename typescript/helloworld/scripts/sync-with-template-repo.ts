/**
 * This script copies over files from this monorepo to the template repo
 * It assumes the template repo is available locally at PATH_TO_TEMPLATE_REPO
 * It will aggregate commits to this folder as the commit message
 * Pull requests must still be created and merged on the template repo
 *
 * Possible improvements:
 * 1. Clone template automatically if it doesn't exist
 * 2. Auto generate commit message based on changes since last sync
 * 3. Run in CI using github token
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const PATH_TO_TEMPLATE_REPO = '../../../abacus-app-template';

const SYNC_WHITELIST = [
  'contracts',
  'src',
  '.gitignore',
  '.prettierignore',
  '.solcover.js',
  '.solhint.json',
  'hardhat.config.ts',
  'package.json',
  'README.md',
];

async function main() {
  console.info('Attempting to sync files with template repo');
  console.info('Using repo path:', PATH_TO_TEMPLATE_REPO);

  if (!existsSync(PATH_TO_TEMPLATE_REPO)) {
    throw new Error('No folder found at repo path');
  }

  const t = new Date();
  const date = `${t.getFullYear()}-${
    t.getMonth() + 1
  }-${t.getDate()}-${t.getHours()}-${t.getMinutes()}`;
  const branchName = `sync-${date}`;
  execSync(`git checkout main && git pull`, { cwd: PATH_TO_TEMPLATE_REPO });
  execSync(`git checkout -b ${branchName}`, {
    cwd: PATH_TO_TEMPLATE_REPO,
  });

  for (const f of SYNC_WHITELIST) {
    console.info(`Copying ${f}`);
    execSync(`cp -r ${f} ${PATH_TO_TEMPLATE_REPO}`);
  }
  console.info(`Done copying files, committing changes`);

  execSync(`git add . && git commit -m "Sync with monorepo"`, {
    cwd: PATH_TO_TEMPLATE_REPO,
  });
  execSync(`git push -u origin ${branchName}`, { cwd: PATH_TO_TEMPLATE_REPO });

  console.info(
    `Changes pushed to branch ${branchName}, please create pull request manually`,
  );
}

main()
  .then(() => console.info('Sync complete!'))
  .catch((e) => console.error('Sync failed', e));
