---
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/cli": patch
---

Composite submitters can now resolve a nested submitter whose type is only registered via a custom factory (such as the CLI's `file` submitter), and ICA file output is self-describing:

- Threaded custom submitter factories through nested submitter resolution. Previously `getSubmitter` passed the bare `getSubmitter` as the recursive `getSubmitterFn`, defaulting `additionalSubmitterFactories` to an empty map, so a wrapping submitter (`interchainAccount` or `timelockController`) could not resolve a nested submitter registered only via a custom factory. The recursive getter now merges the parent's `additionalSubmitterFactories` into any factories a nested caller passes, so custom factories survive recursion at depth >= 2.
- Refactored the SDK's ICA and timelock submitter schemas into the `buildEvmIcaTxSubmitterPropsSchema` and `buildEvmTimelockControllerSubmitterPropsSchema` builders (parameterized by the nested submitter schema) and exported them alongside the `EvmTimelockControllerSubmitterProps` type, so the CLI derives its extended strategy schemas from them instead of re-declaring the wrapper fields.
- Widened the CLI's `ExtendedChainSubmissionStrategySchema` to accept any extended submitter (including `file`) as both the ICA `internalSubmitter` and the timelock `proposerSubmitter`. Previously the `file` submitter was permitted only at the top level and as an ICA `internalSubmitter`, rejecting it as a timelock `proposerSubmitter`. This also widens the optional `feeSubmitter` to the same recursive shape.
- Set the `from` field of the ICA `callRemote` transaction to the configured ICA `owner` rather than the signer that populated it, so file-submitter output is self-describing for downstream broadcasters. `callRemote` derives the interchain account from `msg.sender`, so broadcasting from the deployer key would have silently routed the dispatch to the wrong account. Live submitters are unaffected because `MultiProvider.prepareTx` resets `from` to the actual signer.
