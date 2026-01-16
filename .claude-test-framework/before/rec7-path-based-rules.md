# BEFORE: Recommendation #7 - Path-Based Rule Activation

## Test Setup

- **Test Prompt:** "Fix a bug in rust/main/agents/relayer/src/processor.rs"
- **Date:** 2026-01-16

## Current Configuration

Some rules have path-based activation (rust.md, solidity.md, typescript.md) but not all:

- operations.md - No paths specified
- sdk-migration.md - No paths specified
- mcp-setup.md - No paths specified

## Observed Behavior

When working on Rust files:

- rust.md rules activate (has `paths: rust/**/*.rs`)
- But other relevant rules may not activate
- Context-specific guidance may be missed

### Response Quality

- **Score: 4/5** - Good for some domains, inconsistent for others

### Problems Identified

1. Not all rules have path-based activation
2. Operational context not triggered by file paths
3. SDK migration rules not activated when editing SDK files
