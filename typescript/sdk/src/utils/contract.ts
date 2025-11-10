import { compareVersions } from 'compare-versions';

export function isValidContractVersion(
  currentVersion: string,
  targetVersion: string,
): boolean {
  return compareVersions(currentVersion, targetVersion) >= 0;
}
