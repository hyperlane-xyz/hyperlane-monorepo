---
name: inline-pr-comments
description: Post inline PR review comments on specific lines. Use this skill to deliver code review feedback as inline comments rather than a single summary.
---

# Inline PR Comments Skill

Use this skill to post code review feedback as inline comments on specific lines in a PR.

## When to Use

- After completing a code review (use with /claude-review, /claude-security-review, /claude-tob-review)
- When you have specific line-by-line feedback to deliver
- To make review feedback more actionable

## Instructions

Post a review with inline comments using `gh api`:

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews --input - << 'EOF'
{
  "event": "COMMENT",
  "body": "Optional summary of overall findings",
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "body": "Issue description and suggested fix"
    },
    {
      "path": "another/file.ts",
      "start_line": 10,
      "line": 15,
      "body": "Multi-line comment spanning lines 10-15"
    }
  ]
}
EOF
```

### Comment Fields

- `path` - File path relative to repo root
- `line` - Line number in the NEW version of the file (right side of diff)
- `start_line` + `line` - For comments spanning multiple lines
- `body` - Markdown-formatted feedback

### Limitations

- Can only comment on lines that appear in the diff (changed/added lines)
- Comments on unchanged lines will fail with "Line could not be resolved"

### Feedback Guidelines

| Feedback Type                 | Where to Put It                                           |
| ----------------------------- | --------------------------------------------------------- |
| Specific code issue           | Inline comment on that line                               |
| Pattern repeated across files | Inline on first occurrence + note "same issue in X, Y, Z" |
| Overall architecture concern  | Summary body                                              |
| Approval/changes requested    | Use `event: "APPROVE"` or `event: "REQUEST_CHANGES"`      |

Be concise. Group minor style issues together.
