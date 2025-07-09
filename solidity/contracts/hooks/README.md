# Post-Dispatch Hooks

Post-dispatch hooks allow developers to configure additional origin chain behavior with message content dispatched via the Mailbox.

```mermaid
flowchart TB
    subgraph Origin
      Sender
      M_O[(Mailbox)]
      Hook[IPostDispatchHook]

      Sender -- "dispatch(..., metadata, hook)\n{value}" --> M_O
      M_O -- "postDispatch(message, metadata)\n{value}" --> Hook
    end
```

If the `postDispatch` function receives insufficient payment, it may revert.

> [!WARNING]
> Post-Dispatch Hooks may be replayable. Developers creating custom hooks should implement safe checks to prevent this behavior. [Here](./warp-route/RateLimitedHook.sol#L16) is an example implementation.

### Quote Dispatch (Fees)

Fees are often charged in `postDispatch` to cover costs such as destination chain transaction submission and security provisioning. To receive a quote for a corresponding `postDispatch` call, you can query the `quoteDispatch` function.

The Mailbox has a `quoteDispatch` function that returns the aggregate fee required for a `dispatch` call to be successful.

```mermaid
flowchart TB
    subgraph Origin
      Sender
      M_O[(Mailbox)]
      R_H[RequiredHook]
      Hook[Hook]

      Sender -- "quoteDispatch(..., metadata, hook)" --> M_O
      M_O -- "required = quoteDispatch(message, metadata)" --> R_H
      M_O -- "fee = hook.quoteDispatch(message, metadata)" --> Hook
      M_O -- "required + fee" --> Sender
    end
```

The custom `metadata` will be passed to the required hook's `quoteDispatch` and `postDispatch` functions, before being passed to the default hook's `postDispatch` function.

```mermaid
flowchart LR
    subgraph Origin Chain
      Sender
      M_O[(Mailbox)]
      R_H[RequiredHook]
      D_H[DefaultHook]
      Sender -- "dispatch(..., metadata){value}" --> M_O

      M_O -. "fee = quoteDispatch(...)" .- R_H
      M_O -- "postDispatch(metadata, ...)\n{fee}" --> R_H
      M_O -. "postDispatch(metadata, ...)\n{value - fee}" ..-> D_H
    end
```
