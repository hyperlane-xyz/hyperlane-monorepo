import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Only mask digests in explicit OCI image fields/references. Never skip the
// whole line: another value on that line can still contain a private key.
function withoutImageDigests(line) {
  return line
    .replace(
      /((?:^|[\s{,])["']?imageDigest["']?\s*:\s*["']?sha256:)[a-f0-9]{64}(?=["'\s,}]|$)/g,
      '$1<public-digest>',
    )
    .replace(
      /((?:^|[\s{,])["']?image["']?\s*:\s*["']?[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:)[a-f0-9]{64}(?=["'\s,}]|$)/g,
      '$1<public-digest>',
    )
    .replace(
      /(^\s*FROM\s+(?:--platform=\S+\s+)?[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:)[a-f0-9]{64}(?=\s|$)/g,
      '$1<public-digest>',
    );
}

export function scanPrivateKeys(diff) {
  const findings = [];
  let file = '<unknown>';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (!line.startsWith('+')) continue;
    const content = withoutImageDigests(line.slice(1));
    for (const [kind, pattern] of [
      ['EVM', /\b(?:0x)?[0-9a-fA-F]{64}\b/],
      ['Solana base58', /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/],
      ['Solana byte array', /\[(\s*[0-9]{1,3}\s*,\s*){63}[0-9]{1,3}\s*\]/],
    ]) {
      if (pattern.test(content)) findings.push({ file, kind });
    }
  }
  return findings;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const findings = scanPrivateKeys(
      execFileSync(
        'git',
        [
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--unified=0',
          '--output-indicator-new=+',
        ],
        {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
    );
    for (const { file, kind } of findings) {
      console.error(`${file}: possible ${kind} private key (value redacted)`);
    }
    if (findings.length > 0) process.exitCode = 1;
  } catch {
    // execFileSync errors include stdout: never print an error containing the diff.
    console.error(
      'Could not scan staged changes (git failed or diff exceeded 16 MiB); commit blocked.',
    );
    process.exitCode = 1;
  }
}
