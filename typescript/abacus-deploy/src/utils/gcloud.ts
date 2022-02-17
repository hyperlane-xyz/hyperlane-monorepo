import { execCmd } from './utils';

export async function fetchGCPSecret(
  secretName: string,
  parseJson: boolean = true,
) {
  const [output] = await execCmd(
    `gcloud secrets versions access latest --secret ${secretName}`,
  );
  if (parseJson) {
    return JSON.parse(output);
  }
  return output;
}
