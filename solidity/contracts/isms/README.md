# Interchain Security Modules

Interchain security modules allow developers to configure additional security checks for message content dispatched via the Mailbox.

```mermaid
flowchart LR
    subgraph Destination Chain
      ISM[InterchainSecurityModule]
      Recipient[Recipient]
      M_D[(Mailbox)]

      M_D -- "verify(metadata, message)" --> ISM
      ISM -. "interchainSecurityModule()" .- Recipient
      M_D -- "handle(origin, sender, body)" --> Recipient

    end
```

> [!WARNING]
> Interchain security modules may be replayable. Developers creating custom modules should include replay protection if necessary. [Here](./warp-route/RateLimitedIsm.sol#L23) is an example implementation.
