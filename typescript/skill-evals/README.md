# Skill Evals

Evaluation framework for testing Claude Code skills. Runs prompts through Claude Code and uses Haiku to judge whether the results meet expectations.

## Setup

### Prerequisites

- Node.js 18+
- pnpm
- Claude Code CLI installed and authenticated

### Install Dependencies

```bash
pnpm install
```

### Build

```bash
pnpm -C typescript/skill-evals build
```

### API Key

The framework requires an `ANTHROPIC_API_KEY` for the Haiku judge that evaluates results.

If you have Claude Code installed, you can retrieve your API key:

```bash
export ANTHROPIC_API_KEY=$(security find-generic-password -s "Claude Code" -w)
```

Or set it directly:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

### Run All Evals

```bash
pnpm -C typescript/skill-evals eval
```

### Filter Evals

Use `--filter` (or `-f`) with a regex pattern to run specific evals:

```bash
# Run evals for a specific skill
pnpm -C typescript/skill-evals eval --filter "alert-validator"

# Run a specific eval by name
pnpm -C typescript/skill-evals eval -f "alert-validator-checkpoints-inconsistent/eval-00"
```

### Verbose Mode

Use `--verbose` (or `-v`) to see full agent interactions and judge reasoning:

```bash
pnpm -C typescript/skill-evals eval -v
```

### Concurrency

Control parallelism with `--concurrency` (or `-c`):

```bash
pnpm -C typescript/skill-evals eval -c 4
```

### All Options

```
Options:
  --filter, -f       Regex pattern to filter eval names
  --verbose, -v      Output full eval result and judge reasoning [default: false]
  --concurrency, -c  Number of evals to run in parallel [default: 2]
  --help             Show help
```

## Writing Evals

Evals live in `evals/<skill-name>/<eval-name>/` with two files:

### `eval-prompt.md`

The prompt sent to Claude Code. Include any necessary context, chain names, timestamps, etc.

```markdown
Debug the validator checkpoint inconsistency alert for ethereum.
The alert fired at 2024-01-15T10:00:00Z.
```

### `eval-expected.md`

Expected outcomes the judge will evaluate against. Focus on key points, not exact wording.

```markdown
- Identified stalled validators by address
- Showed validator aliases from multisigIsm.ts
- Displayed threshold and quorum status
- Provided severity assessment
```

## Scoring

The Haiku judge rates results 1-10:

| Score | Meaning                              |
| ----- | ------------------------------------ |
| 1-3   | Major issues, missed key objectives  |
| 4-5   | Partially complete, significant gaps |
| 6-7   | Mostly complete, minor issues        |
| 8-9   | Good quality, meets expectations     |
| 10    | Exceptional, exceeds expectations    |

**Pass threshold: 8+**

## Directory Structure

```
typescript/skill-evals/
├── src/
│   ├── run-evals.ts   # CLI entry point
│   ├── runner.ts      # Claude Code Agent SDK runner
│   ├── judge.ts       # Haiku-based result evaluator
│   ├── report.ts      # Output formatting
│   └── types.ts       # TypeScript interfaces
├── evals/
│   └── <skill-name>/
│       └── <eval-name>/
│           ├── eval-prompt.md
│           └── eval-expected.md
└── package.json
```
