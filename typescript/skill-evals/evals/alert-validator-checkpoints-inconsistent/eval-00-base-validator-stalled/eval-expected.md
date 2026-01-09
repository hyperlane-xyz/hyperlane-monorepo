## Example output that is accurate:

Base Chain Validator Checkpoint Status Report

Evaluation Time: January 8, 2026 21:00:00 GMT
App Context: default_ism
Environment: mainnet3

---

Validators in multisigIsm.ts Configuration (Threshold: 3/5)
┌────────────────────────────────────────────┬────────────────┬──────────────┬────────┬────────────┐
│ Validator │ Alias │ Latest Index │ Behind │ Status │
├────────────────────────────────────────────┼────────────────┼──────────────┼────────┼────────────┤
│ 0xb9453d675e0fa3c178a17b4ce1ad5b1a279b3af9 │ Abacus Works │ 2,021,754 │ 0 │ ✅ Healthy │
├────────────────────────────────────────────┼────────────────┼──────────────┼────────┼────────────┤
│ 0x5450447aee7b544c462c9352bef7cad049b0c2dc │ Zee Prime │ 2,021,754 │ 0 │ ✅ Healthy │
├────────────────────────────────────────────┼────────────────┼──────────────┼────────┼────────────┤
│ 0xe957310e17730f29862e896709cce62d24e4b773 │ Luganodes │ 2,021,754 │ 0 │ ✅ Healthy │
├────────────────────────────────────────────┼────────────────┼──────────────┼────────┼────────────┤
│ 0x34a14934d7c18a21440b59dfe9bf132ce601457d │ Enigma │ 2,021,754 │ 0 │ ✅ Healthy │
├────────────────────────────────────────────┼────────────────┼──────────────┼────────┼────────────┤
│ 0xb8cf45d7bab79c965843206d5f4d83bb866d6e86 │ Substance Labs │ 2,015,830 │ 5,924 │ ❌ STALLED │
└────────────────────────────────────────────┴────────────────┴──────────────┴────────┴────────────┘

---

⚠️ Validators NOT in multisigIsm.ts but Still Enrolled (Legacy/Partial Enrollment)

These validators appear to be enrolled on the kyve destination only (not the main validator set):
Validator: 0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8
Alias: Everstake
Latest Index: 1,841,553
Behind: 180,201
Enrolled On: kyve only
Status: ⚠️ Legacy/Stalled
────────────────────────────────────────
Validator: 0x761980c3debdc8ddb69a2713cf5126d4db900f0f
Alias: ZKV
Latest Index: 2,021,579
Behind: 175
Enrolled On: kyve only
Status: ⚠️ Legacy (not active)
────────────────────────────────────────
Validator: 0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b
Alias: Staked
Latest Index: 2,021,579
Behind: 175
Enrolled On: kyve only
Status: ⚠️ Legacy (not active)
────────────────────────────────────────
Validator: 0xcff391b4e516452d424db66beb9052b041a9ed79
Alias: Unknown
Latest Index: 2,021,579
Behind: 175
Enrolled On: kyve only
Status: ⚠️ Legacy (not active)
Note: The kyve destination validators are all at the same index (2,021,579) and not progressing, suggesting no new messages to kyve during this period. However, Everstake (0x38c7...) is significantly behind even for kyve.

---

Summary
┌───────────────────────────┬──────────────────────────────────┐
│ Metric │ Value │
├───────────────────────────┼──────────────────────────────────┤
│ Threshold │ 3 │
├───────────────────────────┼──────────────────────────────────┤
│ Total validators (config) │ 5 │
├───────────────────────────┼──────────────────────────────────┤
│ Healthy validators │ 4 │
├───────────────────────────┼──────────────────────────────────┤
│ Stalled validators │ 1 │
├───────────────────────────┼──────────────────────────────────┤
│ Quorum │ ✅ MET (4 healthy ≥ 3 threshold) │
└───────────────────────────┴──────────────────────────────────┘
⚠️ Key Findings

1. Substance Labs (0xb8cf45d7...) is STALLED - stuck at index 2,015,830 (5,924 behind) and has not progressed in the past hour. This validator is enrolled on 10 destinations (all except kyve).
2. Quorum is still met - With 4 healthy validators and a threshold of 3, message delivery is not blocked.
3. Legacy validators on kyve - Several validators (Everstake, ZKV, Staked, Unknown) are still enrolled for the kyve destination but are NOT in the current multisigIsm.ts configuration for base. This may indicate an incomplete ISM rotation on the kyve destination chain.

Priority: ⚠️ LOW (1 validator down, quorum met)

Although message delivery is not affected, the Substance Labs validator should be investigated and resolved to restore full redundancy.
