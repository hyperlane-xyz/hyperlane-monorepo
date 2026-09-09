import assert from 'node:assert/strict';
import { test } from 'node:test';

import { productionSourceFiles } from './sealevel-source-hash.mjs';

test('fingerprints embedded program dependencies, excluding host test crates', () => {
  const files = productionSourceFiles();
  for (const path of [
    'rust/sealevel/programs/mailbox/src/processor.rs',
    'rust/sealevel/programs/hyperlane-sealevel-igp/src/processor.rs',
    'rust/sealevel/programs/ism/test-ism/src/program.rs',
    'rust/main/hyperlane-core/src/lib.rs',
    'rust/sealevel/Cargo.lock',
  ])
    assert(files.includes(path), `Missing production input: ${path}`);
  for (const path of files) {
    assert(!path.includes('/mailbox-test/'), path);
    assert(!path.includes('/hyperlane-sealevel-igp-test/'), path);
    assert(!path.includes('/test-utils/'), path);
    assert(!path.includes('/test-transaction-utils/'), path);
  }
});
