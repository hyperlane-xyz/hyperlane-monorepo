import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';

import { loadConfig, parseFrontmatter } from '../src/config/schema.js';

describe('config', () => {
  it('parses markdown frontmatter config', async () => {
    const path = join(tmpdir(), `llm-rebalancer-config-${Date.now()}.md`);
    await writeFile(
      path,
      `---\nwarpRouteIds:\n  - MULTI/stableswap\nregistryUri: /tmp/registry\nllmProvider: codex\nllmModel: gpt-5\nintervalMs: 30000\ndb:\n  url: sqlite:///tmp/llm-rebalancer-test.db\ninflightMode: hybrid\nskills:\n  profile:\n    observe: ./skills/observe/SKILL.md\n    inflightRpc: ./skills/inflight-rpc/SKILL.md\n    inflightExplorer: ./skills/inflight-explorer/SKILL.md\n    inflightHybrid: ./skills/inflight-hybrid/SKILL.md\n    executeMovable: ./skills/execute-movable/SKILL.md\n    executeInventoryLifi: ./skills/execute-inventory-lifi/SKILL.md\n    reconcile: ./skills/reconcile/SKILL.md\n    globalNetting: ./skills/global-netting/SKILL.md\nsignerEnv: HYP_REBALANCER_KEY\ninventorySignerEnv: HYP_INVENTORY_KEY\nexecutionPaths:\n  - movableCollateral\n  - inventory\ninventoryBridge: lifi\nruntime:\n  type: pi-openclaw\n  command: openclaw\n  argsTemplate:\n    - skills\n    - run\n    - --skill\n    - '{skillPath}'\n    - --input\n    - '{inputPath}'\n    - --output\n    - '{outputPath}'\n  timeoutMs: 120000\n---\n\n# body`,
      'utf8',
    );

    const config = loadConfig(path);
    expect(config.warpRouteIds).to.deep.equal(['MULTI/stableswap']);
    expect(config.db.url).to.equal('sqlite:///tmp/llm-rebalancer-test.db');
    expect(config.runtime.command).to.equal('openclaw');
  });

  it('throws for missing frontmatter', () => {
    expect(() => parseFrontmatter('# no frontmatter')).to.throw(
      'Missing markdown frontmatter',
    );
  });
});
