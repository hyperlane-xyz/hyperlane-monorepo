# Plan: SVM MultiCollateral Main E2E

## Goal

Prove SVM MultiCollateral works in the intended user flow, not just raw message compatibility.

Target:

- SVM MC deployable via existing tooling
- SVM MC interoperable with EVM MC
- end-to-end send path exercises MC-specific routing semantics
- prove one SVM MC can route to:
  - a local SVM sibling
  - 2 asset siblings on one EVM chain
- preserve a later phase to migrate this e2e to TS CLI once artifact-manager work lands

## Current State

Done:

- SVM MultiCollateral program exists
- Rust functional tests cover core MC behavior:
  - enroll / unenroll
  - accept enrolled routers on handle
  - `TransferRemoteTo`
  - same-chain CPI
- Sealevel client supports:
  - MC deploy
  - MC token type
  - `mailbox process`
- current shell e2e proves:
  - SVM MC <-> 2 EVM collateral chains
  - manual deploy / manual enroll / manual relay

Missing:

- EVM side still uses plain `HypERC20Collateral`, not EVM `MultiCollateral`
- e2e does not exercise MC-specific target-router selection end-to-end
- e2e does not prove one SVM MC can route across both:
  - local SVM sibling
  - multiple EVM-side sibling assets

## Success Criteria

1. Restore a checked-in plan doc for this branch.
2. Add an e2e that validates SVM MC against EVM MC, not EVM collateral.
3. Ensure at least one test proves MC-specific routing:
   - multiple routers for a domain exist
   - selected target router is the one actually used
4. Ensure the main e2e proves mixed routing:
   - SVM -> local SVM sibling
   - SVM -> EVM sibling A
   - SVM -> EVM sibling B
5. Keep a lower-level relay test if useful, but make it secondary.

## Workstreams

### 1. Lock scope

Primary scope:

- SVM MC <-> EVM MC cross-protocol e2e
- SVM local-sibling + EVM multi-sibling routing coverage
- MC-specific routing assertion

Out of scope for this branch unless trivial:

- fee program implementation
- production relayer integration
- broad deploy-sdk / artifact API work still sitting in xeno097 PRs

### 2. Rework E2E layers

Keep 2 layers:

#### Layer A: protocol-level smoke

Purpose:

- prove raw dispatch/process still works
- useful for debugging mailbox/process/account-meta issues

Keep existing shell script idea, but rename mentally as protocol smoke.

Changes:

- optional to keep 2 EVM chains
- should clearly state it is not the main product-flow e2e

#### Layer B: main MC routing e2e

Purpose:

- validate intended MC routing behavior

Required flow:

1. deploy SVM MC source
2. deploy SVM MC local sibling
3. deploy one EVM chain with multiple sibling asset routers
4. cross-enroll routers
5. send transfer along each MC path
6. relay/process
7. assert balances and selected router behavior

This should replace the current script and become the primary e2e for the branch.

### 3. Upgrade EVM side to true MC

Replace plain EVM collateral in main e2e with EVM `MultiCollateral`.

Need:

- deploy EVM `MultiCollateral`
- initialize + enroll routers
- fund collateral backing token
- expose/read enrolled router config for assertions

Assertion:

- destination router in dispatched message equals expected MC router, not merely primary remote router

Deferred:

- `warp combine` / `warp apply`
- TS CLI e2e
- artifact-manager integration from pending xeno097 PRs

Later phase:

- port shell e2e coverage to TS CLI once the new artifact API / artifact-manager path is merged
- make config-driven deploy/combine/apply the primary product-flow e2e then

### 4. Add MC-specific end-to-end assertion

The main missing proof today:

- current e2e shows SVM MC can talk to EVM routes
- it does not prove MC semantics are used

Add all of:

- 2 SVM MC programs on same local domain, route to chosen local target via `TransferRemoteTo`
- 2 EVM MC sibling routers on one EVM chain, route to chosen EVM target explicitly
- assertion on dispatched message recipient/router for each path

Minimum assertion:

- the emitted/dispatched Hyperlane message recipient equals chosen target router
- final destination release path succeeds only for enrolled target

### 5. Decide relay strategy

Near-term:

- manual relay in test is acceptable

But:

- use the new Sealevel `mailbox process` helper where possible
- isolate message extraction / delivery helpers into reusable functions

Goal:

- reduce script fragility
- keep relay logic deterministic and inspectable

### 6. Test matrix

Required:

- Rust MC functional tests
- Sealevel client build
- replacement shell e2e covering:
  - SVM -> SVM local sibling
  - SVM -> EVM sibling A
  - SVM -> EVM sibling B

Strongly preferred:

- one negative test for unenrolled router target

Optional:

- keep existing protocol smoke for mailbox/process debugging

## Implementation Order

1. Restore plan doc
2. Replace current shell script with main MC routing e2e
3. Build main shell e2e around:
   - SVM MC source
   - SVM MC local sibling
   - 1 EVM chain with multiple MC siblings
4. Add explicit MC-routing assertions
5. Run targeted verification
6. Later: port same coverage to TS CLI + artifact manager

## Deliverables

- `PLAN.md` restored
- updated e2e strategy documented in code/comments
- current shell script replaced with main shell e2e covering local + remote MC sibling routing
- later-phase note for TS CLI + artifact manager migration
- targeted verification commands + results

## Open Questions

- None currently.
