import { access } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { SkillProfile } from '../types.js';

export class SkillRegistry {
  constructor(
    private readonly profile: SkillProfile,
    private readonly configPath: string,
  ) {}

  async resolveProfile(): Promise<SkillProfile> {
    const baseDir = dirname(this.configPath);

    return {
      observe: await this.resolveSkillPath(this.profile.observe, baseDir),
      inflightRpc: await this.resolveSkillPath(this.profile.inflightRpc, baseDir),
      inflightExplorer: await this.resolveSkillPath(
        this.profile.inflightExplorer,
        baseDir,
      ),
      inflightHybrid: await this.resolveSkillPath(this.profile.inflightHybrid, baseDir),
      executeMovable: await this.resolveSkillPath(this.profile.executeMovable, baseDir),
      executeInventoryLifi: await this.resolveSkillPath(
        this.profile.executeInventoryLifi,
        baseDir,
      ),
      reconcile: await this.resolveSkillPath(this.profile.reconcile, baseDir),
      globalNetting: await this.resolveSkillPath(this.profile.globalNetting, baseDir),
    };
  }

  private async resolveSkillPath(skillPath: string, baseDir: string): Promise<string> {
    const candidates: string[] = [];

    if (isAbsolute(skillPath)) {
      candidates.push(skillPath);
    } else {
      candidates.push(resolve(baseDir, skillPath));
      candidates.push(resolve(process.cwd(), 'typescript/llm-rebalancer', skillPath));
      candidates.push(resolve(process.cwd(), 'typescript/llm-rebalancer/skills', skillPath));
    }

    if (!skillPath.endsWith('.md')) {
      const withSkillMd = skillPath.endsWith('/')
        ? `${skillPath}SKILL.md`
        : `${skillPath}/SKILL.md`;
      if (isAbsolute(withSkillMd)) {
        candidates.push(withSkillMd);
      } else {
        candidates.push(resolve(baseDir, withSkillMd));
        candidates.push(resolve(process.cwd(), 'typescript/llm-rebalancer', withSkillMd));
        candidates.push(
          resolve(process.cwd(), 'typescript/llm-rebalancer/skills', withSkillMd),
        );
      }
    }

    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }

    throw new Error(`Unable to resolve skill path: ${skillPath}`);
  }
}
