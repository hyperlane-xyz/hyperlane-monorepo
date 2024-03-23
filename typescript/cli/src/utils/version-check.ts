import latestVersion from 'latest-version';

import { log } from '../logger.js';
import { VERSION } from '../version.js';

export async function checkVersion() {
  const currentVersion = await latestVersion('@hyperlane-xyz/cli');
  if (VERSION < currentVersion) {
    log(`Your CLI version: ${VERSION}, latest version: ${currentVersion}`);
  }
}
