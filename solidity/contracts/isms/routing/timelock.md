# TimelockRouter with WarpRoute - Message Lifecycle

This document illustrates the complete message lifecycle when a WarpRoute uses TimelockRouter as both its hook and ISM.

## What is TimelockRouter?

**TimelockRouter** is a pure timelock mechanism - it delays message processing by a fixed time window. This provides time for off-chain observation, but does NOT inherently provide fraud proofs or pausing.

**To create true optimistic security with watcher/fraud proof capabilities, aggregate TimelockRouter with PausableISM** (see section below).

## Basic Configuration (Timelock Only)

```solidity
// On both origin and destination chains:
WarpRoute warpRoute;
TimelockRouter timelockRouter;

// Configure WarpRoute to use TimelockRouter
warpRoute.setHook(address(timelockRouter));
warpRoute.setInterchainSecurityModule(address(timelockRouter));
```

## TimelockRouter Architecture

TimelockRouter serves three roles in the message lifecycle:

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph LR
    subgraph "Origin Chain"
        OR1[TimelockRouter]
        style OR1 fill:orange
        M1[(Mailbox)]
    end

    subgraph "Destination Chain"
        OR2[TimelockRouter]
        style OR2 fill:orange
        M2[(Mailbox)]
    end

    OR1 -. "1. Hook Role<br/>postDispatch()" .-> OR1
    OR1 -. "2. Router Role<br/>sends messageId" .-> OR2
    OR2 -. "3. ISM Role<br/>verify()" .-> OR2
```

## Transfer Alice's tokens from Ethereum to Bob on Polygon

This flow shows how TimelockRouter handles both preverification and actual message delivery.

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    Alice((Alice))
    Bob((Bob))
    style Alice fill:black
    style Bob fill:black

    Relayer([Relayer])

    subgraph "Ethereum (Origin)"
        WarpRoute_E[WarpRoute]
        style WarpRoute_E fill:green
        TLRouter_E[TimelockRouter<br/>Hook + Router]
        style TLRouter_E fill:orange
        Mailbox_E[(Mailbox)]
    end

    subgraph "Polygon (Destination)"
        TLRouter_P[TimelockRouter<br/>ISM + Router]
        style TLRouter_P fill:orange
        WarpRoute_P[WarpRoute]
        style WarpRoute_P fill:green
        Mailbox_P[(Mailbox)]
    end

    %% Phase 1: Dispatch
    Alice == "1. transferRemote(Polygon, Bob, amount)" ==> WarpRoute_E
    WarpRoute_E -- "2. dispatch(message)" --> Mailbox_E
    Mailbox_E -- "3. postDispatch(message)<br/>[Hook Role]" --> TLRouter_E

    %% Phase 2: Preverification Message
    TLRouter_E -- "4. dispatch(messageId)" --> Mailbox_E
    Mailbox_E -. "5. indexing" .-> Relayer
    Relayer == "6. process(messageId)" ==> Mailbox_P
    Mailbox_P -- "7. handle(messageId)<br/>[Router Role]" --> TLRouter_P
    TLRouter_P -- "8. readyAt[messageId] =<br/>now + 1 hour" --> TLRouter_P

    %% Phase 3: Wait
    TLRouter_P -. "⏰ Timelock Window<br/>(1 hour)" .-> TLRouter_P

    %% Phase 4: Actual Message
    Relayer == "9. process(message)" ==> Mailbox_P
    Mailbox_P -- "10. verify(message)<br/>[ISM Role]" --> TLRouter_P
    TLRouter_P -- "11. readyAt <= now?<br/>✓ verified" --> Mailbox_P
    Mailbox_P -- "12. handle(message)" --> WarpRoute_P
    WarpRoute_P -- "13. mint(Bob, amount)" --> Bob
    linkStyle 12 color:green;

    TLRouter_E -. "enrolled routers" .- TLRouter_P
```

## Creating Optimistic Security via Threshold Aggregation

TimelockRouter alone only provides a time delay. To create true optimistic security with **fraud proofs and watcher-based pausing**, aggregate it with **PausableISM** and a **finality proof system** using **threshold-based aggregation**:

**Structure**: 1-of-2 aggregation of [2-of-2 aggregation of (pausable + timelock), finality proof]

This provides **two independent paths** to message finality:

- **Fast optimistic path**: Requires BOTH pausable AND timelock (2-of-2)
- **Slow finality path**: Requires only cryptographic proof (bypasses optimistic layer)

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    subgraph "Configuration"
        WR[WarpRoute]
        style WR fill:green

        TLR[TimelockRouter<br/>Hook]
        style TLR fill:orange

        OuterAgg[Outer AggregationISM<br/>1-of-2: EITHER path]
        style OuterAgg fill:purple

        InnerAgg[Inner AggregationISM<br/>2-of-2: BOTH required]
        style InnerAgg fill:purple

        TL_ISM[TimelockRouter<br/>as ISM]
        style TL_ISM fill:orange

        PISM[PausableISM<br/>Watcher Control]
        style PISM fill:red

        ZkProof[ZkProofISM<br/>Rollup Finality]
        style ZkProof fill:blue

        WR -- "setHook()" --> TLR
        WR -- "setISM()" --> OuterAgg
        OuterAgg -- "module[0]<br/>fast path" --> InnerAgg
        OuterAgg -- "module[1]<br/>slow path" --> ZkProof
        InnerAgg -- "module[0]" --> PISM
        InnerAgg -- "module[1]" --> TL_ISM
    end
```

### Deployment Code

```solidity
// 1. Deploy base components
TimelockRouter timelockRouter = new TimelockRouter(mailbox, 1 hours);
PausableIsm pausableIsm = new PausableIsm(watcherAddress);
ZkProofIsm zkProofIsm = new ZkProofIsm(...); // or RollupIsm, any finality ISM

// 2. Inner aggregation (2-of-2): BOTH pausable AND timelock must pass
address[] memory innerModules = new address[](2);
innerModules[0] = address(pausableIsm);      // Must not be paused
innerModules[1] = address(timelockRouter);   // Must pass timelock
StaticAggregationIsm innerAgg = new StaticAggregationIsm(innerModules, 2);

// 3. Outer aggregation (1-of-2): EITHER optimistic path OR finality proof
address[] memory outerModules = new address[](2);
outerModules[0] = address(innerAgg);         // Fast optimistic path
outerModules[1] = address(zkProofIsm);       // Slow finality path
StaticAggregationIsm optimisticIsm = new StaticAggregationIsm(outerModules, 1);

// 4. Configure WarpRoute
warpRoute.setHook(address(timelockRouter));
warpRoute.setInterchainSecurityModule(address(optimisticIsm));
```

### How Dual-Path Optimistic Security Works

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    Mailbox[Mailbox<br/>Destination]

    OuterAgg[Outer AggregationISM<br/>1-of-2: EITHER path]
    style OuterAgg fill:purple

    InnerAgg[Inner AggregationISM<br/>2-of-2: BOTH required]
    style InnerAgg fill:purple

    TL[TimelockRouter.verify]
    style TL fill:orange

    PI[PausableISM.verify]
    style PI fill:red

    ZK[ZkProofISM.verify]
    style ZK fill:blue

    Watcher([Watcher])
    style Watcher fill:black

    Mailbox -- "1. verify()" --> OuterAgg

    OuterAgg -- "2a. Path 1<br/>Fast Optimistic" --> InnerAgg
    OuterAgg -- "2b. Path 2<br/>Slow Finality" --> ZK

    InnerAgg -- "3a. verify()" --> PI
    InnerAgg -- "3b. verify()" --> TL

    PI -- "4a. !paused?<br/>✓ or revert" --> InnerAgg
    TL -- "4b. readyAt <= now?<br/>✓ or revert" --> InnerAgg

    InnerAgg -- "5a. Both pass?<br/>✓ fast path" --> OuterAgg
    ZK -- "5b. Valid proof?<br/>✓ slow path" --> OuterAgg

    OuterAgg -- "6. Either path?<br/>✓ process message" --> Mailbox

    Watcher -. "pause() if fraud" .-> PI
```

**Verification Flow:**

**Path 1 (Fast Optimistic)**: Inner aggregation passes if BOTH conditions met:

- `PausableISM.verify()` passes (not paused)
- `TimelockRouter.verify()` passes (timelock expired)
- Result: Message delivered after timelock, unless paused by watcher

**Path 2 (Slow Finality)**: Bypass optimistic layer entirely:

- `ZkProofISM.verify()` passes (valid ZK proof of rollup finality)
- Result: Message delivered immediately with cryptographic proof

**Outer aggregation** (1-of-2 threshold): Message passes if EITHER path succeeds

**Benefits:**

- Normal case: Fast optimistic path (low cost, 1 hour latency)
- Emergency case: Slow finality path bypasses paused optimistic layer
- Redundancy: Two independent security mechanisms

### Watcher Workflow

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    Monitor[Watcher Monitors<br/>Preverified Messages]
    style Monitor fill:lightblue

    Check{Valid<br/>Message?}

    Wait[Wait for timelock<br/>to expire]
    style Wait fill:green

    Pause[Call pausableIsm.pause]
    style Pause fill:red

    Investigate[Investigate & Resolve]
    style Investigate fill:yellow

    Unpause[Call pausableIsm.unpause]
    style Unpause fill:green

    Monitor --> Check
    Check -- "✓ Valid" --> Wait
    Check -- "✗ Fraud Detected" --> Pause
    Pause --> Investigate
    Investigate --> Unpause
    Unpause --> Wait
```

**Watcher Actions:**

1. **Monitor**: Watch for `MessageQueued` events from TimelockRouter
2. **Validate**: Check if message is valid (e.g., verify merkle proofs, check balances)
3. **Pause if Invalid**: If fraud detected, call `pausableIsm.pause()`
   - Paused messages CANNOT be processed (PausableISM.verify reverts)
   - Gives time to investigate and resolve
4. **Unpause**: After resolution, call `pausableIsm.unpause()`

## Complete Optimistic System: Dual-Path Architecture

For maximum security with optimistic assumptions, use **dual-path threshold aggregation**: `1-of-2 aggregation of [2-of-2 aggregation of (pausable + timelock), finality proof]`

This provides two independent paths to finality, mirroring optimistic rollup architecture.

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    MB[Mailbox]

    OuterAgg[Outer AggregationISM<br/>1-of-2: EITHER path]
    style OuterAgg fill:purple

    InnerAgg[Inner AggregationISM<br/>2-of-2: BOTH required]
    style InnerAgg fill:purple

    PISM[PausableISM<br/>Watcher Control]
    style PISM fill:red

    TL[TimelockRouter<br/>Time Delay]
    style TL fill:orange

    ZK[ZkProofISM<br/>Rollup Finality]
    style ZK fill:blue

    Watcher([Watcher])
    style Watcher fill:black

    MB -- "verify()" --> OuterAgg
    OuterAgg -- "Path 1:<br/>Fast Optimistic" --> InnerAgg
    OuterAgg -- "Path 2:<br/>Slow Finality" --> ZK

    InnerAgg -- "verify()" --> PISM
    InnerAgg -- "verify()" --> TL

    PISM -- "!paused?" --> InnerAgg
    TL -- "readyAt <= now?" --> InnerAgg
    InnerAgg -- "BOTH passed<br/>✓ fast path" --> OuterAgg
    ZK -- "valid proof?<br/>✓ slow path" --> OuterAgg
    OuterAgg -- "EITHER passed<br/>✓ process" --> MB

    Watcher -. "pause()" .-> PISM
```

### Deployment: Complete Optimistic System

```solidity
// 1. Deploy all components
TimelockRouter timelockRouter = new TimelockRouter(mailbox, 1 hours);
PausableIsm pausableIsm = new PausableIsm(watcherAddress);
ZkProofIsm zkProofIsm = new ZkProofIsm(...); // or RollupIsm, any finality ISM

// 2. Inner aggregation (2-of-2): BOTH pausable AND timelock must pass
address[] memory innerModules = new address[](2);
innerModules[0] = address(pausableIsm);      // Must not be paused
innerModules[1] = address(timelockRouter);   // Must pass timelock
StaticAggregationIsm innerAgg = new StaticAggregationIsm(innerModules, 2);

// 3. Outer aggregation (1-of-2): EITHER optimistic path OR finality proof
address[] memory outerModules = new address[](2);
outerModules[0] = address(innerAgg);         // Fast optimistic path
outerModules[1] = address(zkProofIsm);       // Slow finality path
StaticAggregationIsm optimisticIsm = new StaticAggregationIsm(outerModules, 1);

// 4. Configure WarpRoute
warpRoute.setHook(address(timelockRouter));
warpRoute.setInterchainSecurityModule(address(optimisticIsm));
```

### Why Dual-Path Architecture?

This mirrors optimistic rollup architecture with two independent verification paths:

**Path 1: Fast Optimistic (Inner 2-of-2 Aggregation)**

1. **PausableISM** = Fraud proof submission capability

   - Watchers can immediately halt suspicious messages
   - Provides emergency brake during investigation

2. **TimelockRouter** = Challenge period
   - Fixed time window for fraud detection
   - Prevents instant finality, allows observation

**Path 2: Slow Finality (Cryptographic Proof)** 3. **ZkProofISM/RollupISM** = Finality verification

- Cryptographic proof that message is valid (ZK proof, multisig, etc.)
- Bypasses optimistic layer entirely
- Fallback when optimistic path is paused or untrusted

**Security Trade-offs:**

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph LR
    L1[Single Path:<br/>Timelock Only]
    style L1 fill:yellow

    L2[Single Path:<br/>2-of-2 Agg<br/>Pausable + Timelock]
    style L2 fill:orange

    L3[Dual Path:<br/>1-of-2 Agg<br/>Optimistic OR Proof]
    style L3 fill:green

    L1 -- "Add watcher control" --> L2
    L2 -- "Add fallback path" --> L3

    L1 -. "Time delay only<br/>No fraud prevention<br/>No fallback" .- L1
    L2 -. "Time + halt<br/>Single point of failure<br/>(paused = stuck)" .- L2
    L3 -. "Dual-path redundancy<br/>Fast OR slow<br/>Maximum security" .- L3
```

**When to Use Each:**

- **Timelock only**: Low-value transfers, trusted environment, minimal security needs
- **2-of-2 Agg (Pausable + Timelock)**: Medium security with watcher control, but vulnerable to permanent pause
- **1-of-2 Dual-Path**: Maximum security with redundancy - optimistic path can be paused without breaking the system

## Timelock Security Timeline

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph LR
    T0[T+0s<br/>Preverification]
    style T0 fill:orange

    T1[T+1s to T+3600s<br/>Timelock Window]
    style T1 fill:yellow

    T2[T+3600s+<br/>Ready for Delivery]
    style T2 fill:green

    Watchers([Watchers Monitor<br/>Can Pause])
    style Watchers fill:red

    T0 --> T1
    T1 --> T2
    Watchers -. "can pause via<br/>PausableISM" .-> T1

    T0 -. "readyAt stored" .-> T0
    T2 -. "verify() passes<br/>(if not paused)" .-> T2
```

## Two Messages Per Transfer

The TimelockRouter sends **two messages** for each token transfer:

### Message 1: Preverification Message (Steps 4-8)

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph LR
    OR_O[TimelockRouter<br/>Origin]
    style OR_O fill:orange

    OR_D[TimelockRouter<br/>Destination]
    style OR_D fill:orange

    Storage[(readyAt<br/>mapping)]
    style Storage fill:lightblue

    OR_O -- "messageId only" --> OR_D
    OR_D -- "stores readyAt =<br/>now + window" --> Storage
```

**Purpose**: Notify destination that a message is coming and start the timelock timer.

**Payload**: `abi.encode(messageId)` - just the message ID, not the full message

**Handler**: `TimelockRouter.handle()` stores `readyAt[messageId] = block.timestamp + timelockWindow`

### Message 2: Actual Transfer Message (Steps 9-13)

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph LR
    WR_O[WarpRoute<br/>Origin]
    style WR_O fill:green

    OR_D[TimelockRouter<br/>Destination]
    style OR_D fill:orange

    WR_D[WarpRoute<br/>Destination]
    style WR_D fill:green

    WR_O -- "full message" --> OR_D
    OR_D -- "verify()" --> OR_D
    OR_D -- "✓ if ready" --> WR_D
```

**Purpose**: The actual token transfer message.

**Payload**: `TokenMessage` containing recipient, amount, etc.

**Verifier**: `TimelockRouter.verify()` checks `readyAt[messageId] <= block.timestamp`

**Handler**: `WarpRoute.handle()` processes the transfer

## Security Comparison

| Security Model                             | Components                   | Time Delay     | Fraud Prevention         | Cryptographic Proof  | Redundancy    | Security Level |
| ------------------------------------------ | ---------------------------- | -------------- | ------------------------ | -------------------- | ------------- | -------------- |
| **TimelockRouter only**                    | 1 ISM                        | ✓ Yes          | ✗ No                     | ✗ No                 | ✗ Single path | Low            |
| **2-of-2 Agg (Pausable + Timelock)**       | 2 ISMs (both required)       | ✓ Yes          | ✓ Watcher pause          | ✗ No                 | ✗ Single path | Medium         |
| **ZkProofISM only**                        | 1 ISM                        | ✗ No           | N/A                      | ✓ ZK Proof           | ✗ Single path | Medium         |
| **1-of-2 Dual-Path (Optimistic OR Proof)** | 3 ISMs (nested, either path) | ✓ Yes (Path 1) | ✓ Watcher pause (Path 1) | ✓ ZK/Rollup (Path 2) | ✓ Two paths   | **Maximum**    |

**Key Insights**:

- **TimelockRouter** = Time delay building block
- **PausableISM** = Fraud prevention building block
- **ZkProofISM/RollupISM** = Cryptographic verification building block (ZK proofs, multisig, etc.)
- **2-of-2 Aggregation** = Single optimistic path (BOTH pausable AND timelock required)
- **1-of-2 Aggregation** = Dual-path redundancy (EITHER optimistic OR proof succeeds)
- **Complete Optimistic System** = 1-of-2 aggregation providing two independent paths to finality

## Hook and ISM Chaining

TimelockRouter can wrap other hooks and ISMs via MailboxClient inheritance:

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    subgraph "Hook Chain (Origin)"
        WR1[WarpRoute]
        style WR1 fill:green
        TLR1[TimelockRouter]
        style TLR1 fill:orange
        IGP[InterchainGasPaymaster]
        style IGP fill:lightblue

        WR1 -- "1. postDispatch()" --> TLR1
        TLR1 -- "2. postDispatch()<br/>(to wrapped hook)" --> IGP
    end

    subgraph "ISM Chain (Destination)"
        MB[Mailbox]
        AGG[AggregationISM]
        style AGG fill:purple
        TLR2[TimelockRouter]
        style TLR2 fill:orange
        PISM[PausableISM]
        style PISM fill:red
        WR2[WarpRoute]
        style WR2 fill:green

        MB -- "1. verify()" --> AGG
        AGG -- "2a. verify()" --> TLR2
        AGG -- "2b. verify()" --> PISM
        AGG -- "3. both pass" --> MB
        MB -- "4. handle()" --> WR2
    end
```

## Gas Cost Comparison

| Security Model                | Messages | Origin Cost | Destination Cost          | Latency     |
| ----------------------------- | -------- | ----------- | ------------------------- | ----------- |
| No ISM                        | 1        | Low         | Low                       | ~Minutes    |
| ZkProofISM                    | 1        | Medium      | High (proof verification) | ~Minutes    |
| **TimelockRouter only**       | **2**    | **Medium**  | **Medium**                | **~1 hour** |
| **Timelock + Pausable**       | **2**    | **Medium**  | **Medium**                | **~1 hour** |
| Timelock + Pausable + ZkProof | 2        | High        | Very High                 | ~1 hour     |

**Trade-offs**:

- TimelockRouter: Higher latency but no proof verification costs
- Best for non-urgent transfers where time-based security is acceptable
- Add PausableISM for watcher control without increasing gas costs
- Can combine with ZkProofISM/RollupISM for maximum security

## Implementation Details

**Storage**:

```solidity
mapping(bytes32 => uint48) public readyAt;
```

**Preverification** (in `handle()`):

```solidity
readyAt[messageId] = uint48(block.timestamp) + timelockWindow;
emit MessageQueued(messageId, readyAt[messageId]);
```

**Verification** (in `verify()`):

```solidity
uint48 messageReadyAt = readyAt[messageId];
require(messageReadyAt > 0, "not preverified");
require(messageReadyAt <= block.timestamp, "not ready");
return true;
```
