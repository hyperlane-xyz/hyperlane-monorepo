# TimelockRouter

TimelockRouter is a timelock mechanism that delays message processing by a fixed time window. It provides time for off-chain observation and watcher intervention, but does not inherently provide fraud proofs or pausing capabilities.

## 1. Timelock Architecture

TimelockRouter serves **three roles** in the message lifecycle:

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
    end

    subgraph "Destination Chain"
        OR2[TimelockRouter]
        style OR2 fill:orange
    end

    OR1 -. "1. Hook Role<br/>postDispatch()" .-> OR1
    OR1 -. "2. Router Role<br/>sends messageId" .-> OR2
    OR2 -. "3. ISM Role<br/>verify()" .-> OR2
```

**How it works:**

1. **Hook Role (Origin)**: When a message is dispatched, TimelockRouter sends a preverification message containing only the messageId to the destination chain
2. **Router Role (Destination)**: Receives the preverification message via `handle()` and stores `readyAt[messageId] = block.timestamp + timelockWindow`
3. **ISM Role (Destination)**: When the actual message arrives, `verify()` checks that `readyAt[messageId] <= block.timestamp` before allowing processing

**Two messages per transfer:**

- **Message 1 (Preverification)**: Sends messageId to destination, starts timelock timer
- **Message 2 (Actual Message)**: Delivers after timelock expires, verified by ISM

**Storage:**

```solidity
mapping(bytes32 => uint48) public readyAt;
uint48 public immutable timelockWindow;
```

## 2. WarpRoute with Timelock

Configure WarpRoute to use TimelockRouter as both hook and ISM:

```solidity
warpRoute.setHook(address(timelockRouter));
warpRoute.setInterchainSecurityModule(address(timelockRouter));
```

**Test flow** (from `test_warpRouteFlow`):

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
    User((User))
    style User fill:black

    subgraph "Origin Chain"
        WarpRoute_O[WarpRoute]
        style WarpRoute_O fill:green
        TLRouter_O[TimelockRouter<br/>Hook]
        style TLRouter_O fill:orange
        Mailbox_O[(Mailbox)]
    end

    subgraph "Destination Chain"
        TLRouter_D[TimelockRouter<br/>ISM + Router]
        style TLRouter_D fill:orange
        WarpRoute_D[WarpRoute]
        style WarpRoute_D fill:green
        Mailbox_D[(Mailbox)]
    end

    Fail1[❌ Step 2: Try process msg 1<br/>REVERTS: not preverified]
    style Fail1 fill:red,color:white

    Fail2[❌ Step 4: Try process msg 1<br/>REVERTS: not ready]
    style Fail2 fill:red,color:white

    Success[✓ Step 6: Process msg 1<br/>SUCCESS: tokens delivered]
    style Success fill:green,color:white

    %% Step 1: Transfer
    User == "Step 1: transferRemote(amount)<br/>→ dispatches 2 messages" ==> WarpRoute_O
    WarpRoute_O -- "dispatch(transfer msg)" --> Mailbox_O
    Mailbox_O -- "postDispatch()<br/>[Hook]" --> TLRouter_O
    TLRouter_O -- "dispatch(preverify msg)" --> Mailbox_O

    %% Messages in mailbox
    Mailbox_O -. "msg 0: preverify<br/>msg 1: transfer" .-> Mailbox_O

    %% Step 2: Try to process transfer before preverification
    Mailbox_D -. "Step 2" .-> Fail1

    %% Step 3: Process preverification
    Mailbox_O == "Step 3: process msg 0" ==> Mailbox_D
    Mailbox_D -- "handle(messageId)<br/>[Router]" --> TLRouter_D
    TLRouter_D -- "readyAt[id] =<br/>now + 1 hour" --> TLRouter_D

    %% Step 4: Try to process transfer before timelock
    TLRouter_D -. "Step 4" .-> Fail2

    %% Step 5: Wait
    TLRouter_D -. "Step 5: warp time<br/>+1 hour ⏰" .-> TLRouter_D

    %% Step 6: Process transfer successfully
    Mailbox_O == "Step 6: process msg 1" ==> Mailbox_D
    Mailbox_D -- "verify()<br/>[ISM]" --> TLRouter_D
    TLRouter_D -- "readyAt <= now?<br/>✓ pass" --> Mailbox_D
    Mailbox_D -- "handle(transfer)" --> WarpRoute_D
    WarpRoute_D -- "mint(amount)" --> User

    User -. "Step 6" .-> Success

    TLRouter_O -. "enrolled<br/>routers" .- TLRouter_D
```

## 3. Optimistic Security with Aggregation

TimelockRouter alone provides time delay. To create **optimistic security with fraud proofs and watcher control**, aggregate it with PausableISM and a finality proof system using **threshold-based aggregation**.

**Architecture**: 1-of-2 aggregation of [2-of-2 aggregation of (pausable + timelock), finality proof]

This provides **two independent paths** to message finality:

- **Fast optimistic path** (Path 1): Requires BOTH pausable AND timelock (2-of-2 aggregation)
- **Slow finality path** (Path 2): Requires only cryptographic proof, bypasses optimistic layer

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

**Verification flow:**

**Path 1 (Fast Optimistic)**: Inner 2-of-2 aggregation requires BOTH:

- `PausableISM.verify()` passes (not paused by watcher)
- `TimelockRouter.verify()` passes (timelock expired)
- **Result**: Message delivered after timelock window, unless paused

**Path 2 (Slow Finality)**: Bypass optimistic layer entirely:

- `ZkProofISM.verify()` passes (valid ZK proof or cryptographic finality)
- **Result**: Message delivered immediately with cryptographic proof

**Outer 1-of-2 aggregation**: Message succeeds if EITHER path passes

**Benefits:**

- **Normal case**: Fast optimistic path (low cost, ~1 hour latency)
- **Emergency case**: Slow finality path bypasses paused optimistic layer
- **Redundancy**: Two independent security mechanisms

**Watcher workflow:**

1. **Monitor**: Watch for `MessageQueued` events from TimelockRouter
2. **Validate**: Check if message is valid (verify proofs, check state consistency)
3. **Pause if fraud detected**: Call `pausableIsm.pause()` to halt message processing
4. **Investigate & resolve**: Fix issues, then call `pausableIsm.unpause()`

**Security comparison:**

| Security Model                             | Time Delay | Fraud Prevention    | Cryptographic Proof | Redundancy      | Security Level |
| ------------------------------------------ | ---------- | ------------------- | ------------------- | --------------- | -------------- |
| TimelockRouter only                        | ✓          | ✗                   | ✗                   | ✗ Single path   | Low            |
| 2-of-2 Agg (Pausable + Timelock)           | ✓          | ✓ Watcher pause     | ✗                   | ✗ Single path   | Medium         |
| ZkProofISM only                            | ✗          | N/A                 | ✓                   | ✗ Single path   | Medium         |
| **1-of-2 Dual-Path (Optimistic OR Proof)** | **✓**      | **✓ Watcher pause** | **✓**               | **✓ Two paths** | **Maximum**    |

**Key insights:**

- **TimelockRouter** = Time delay building block
- **PausableISM** = Fraud prevention building block
- **ZkProofISM/RollupISM** = Cryptographic verification building block
- **Complete optimistic system** = 1-of-2 aggregation providing dual-path redundancy
