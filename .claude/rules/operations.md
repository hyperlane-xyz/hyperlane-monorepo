# Operations & Debugging Rules

## Primary Reference

For comprehensive operational debugging guidance, **always consult**:

- `docs/ai-agents/operational-debugging.md` - Detailed Grafana/GCP debugging workflows
- [Operations Runbook](https://www.notion.so/hyperlanexyz/Runbook-AI-Agent-24a6d35200d680229b38e8501164ca66) - Manual procedures

## Debugging Priority Order

1. **Start with Grafana** - Check alerts and dashboards first
2. **Use Hyperlane Explorer** - Find stuck messages before querying logs
3. **Query GCP logs** - Only after understanding the high-level issue

## Key Dashboards

| Dashboard          | UID                                    | Use For                          |
| ------------------ | -------------------------------------- | -------------------------------- |
| Easy Dashboard     | `fdf6ada6uzvgga`                       | Queue lengths, reprepare reasons |
| Relayers v2 & v3   | `k4aYDtK4k`                            | Prepare queues, message flow     |
| RPC Usage & Errors | `bdbwtrzoms5c0c`                       | RPC error rates                  |
| Lander Dashboard   | `197feea9-f831-48ce-b936-eaaa3294a3f6` | Transaction submission           |
| Validator In-house | `xrNCvpK4k`                            | Internal validator health        |
| Validator External | `cdqntgxna4vswd`                       | External validator status        |

## Common Error Patterns

| Error                      | Priority | Action                                               |
| -------------------------- | -------- | ---------------------------------------------------- |
| `eth_estimateGas` failures | HIGH     | Check for contract reverts, decode with `cast 4byte` |
| High retry counts (40+)    | HIGH     | Investigate persistent issues                        |
| `CouldNotFetchMetadata`    | LOW      | Only check validators after 5+ min delays            |
| Nonce errors               | LOW      | Normal during gas escalation unless persistent       |
| Connection resets          | LOW      | Normal RPC hiccups unless frequent                   |
| 503 errors                 | LOW      | Provider issues, only investigate if persistent      |

## Validator Debugging

Use `hyperlane_observed_validator_latest_index{origin="[chain]"}` for ALL validators (including external).

Convert addresses to names: `grep -i "[address]" typescript/sdk/src/consts/multisigIsm.ts`

## Gas Price Escalation

```
Max(Min(Max(Escalate(oldGasPrice), newEstimatedGasPrice), gasPriceCapMultiplier × newEstimatedGasPrice), oldGasPrice)
```

The `gasPriceCapMultiplier` is configurable per chain in `transactionOverrides` (default: 3).
