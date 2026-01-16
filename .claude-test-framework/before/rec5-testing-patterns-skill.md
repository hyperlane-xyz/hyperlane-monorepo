# BEFORE: Recommendation #5 - Testing Patterns Skill

## Test Setup

- **Test Prompt:** "Write tests for the WarpCore.getTransferFee function"
- **Date:** 2026-01-16

## Current Configuration

No testing-specific skill. When asked to write tests:

- Claude uses general knowledge
- No project-specific patterns enforced
- May not follow TDD workflow
- Factory patterns not consistently applied

## Observed Behavior

When asked to write tests:

1. Claude writes tests based on general patterns
2. May not use factory functions for mock data
3. May not follow Arrange-Act-Assert structure
4. Test organization varies by session
5. No integration with project-specific test utilities

### Response Quality

- **Score: 3/5** - Functional tests but inconsistent patterns

### Problems Identified

1. No factory function usage guidance
2. TDD workflow not enforced
3. Project-specific patterns not applied
4. Mocking strategies vary
