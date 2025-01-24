---
'@hyperlane-xyz/core': major
---

## Changes

Add immutable `scale` parameter to all warp route variants which scales outbound amounts **down** and inbound amounts **up**. This is useful when different chains of the route have different decimal places to unify semantics of amounts in messages.

Removes `HypNativeScaled` in favor of `HypNative` with `scale` parameter.

## Migration

If you want to keep the same behavior as before, you can set `scale` to `1` in all your routes.

### `TokenRouter` Usage
```diff
- TokenRouter(mailbox)
+ TokenRouter(scale, mailbox)
```

### `HypNativeScaled` Usage
```diff
- HypNativeScaled(scale, mailbox)
+ HypNative(scale, mailbox)
```
