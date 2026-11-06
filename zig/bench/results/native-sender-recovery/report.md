# Native sender recovery evidence

Historical released focused roots: Tron20/20 (two substantive tests) and
Starknet26/26 (six substantive tests), no skips. Remaining counts are transitive
root smoke declarations. Commands, complete raw logs, earlier compile failures
and reports are preserved losslessly in deterministic gzip archives.

Original result JSON records post-run Source/SDK hashes. Subsequent integration
changed production dependencies; this archive does not claim current-head
acceptance. source-status.json.gz records each exact mismatch. Only source bytes
still matching the recorded hashes are archived as matching historical bytes.
Final frozen combined/default/native/Postgres/role and exact matrix artifact
checks remain required before timing or rewrite completion.

The Tron slice uses actual Driver/Factory/std signing/Rocks plus the common Root
gate. It covers cold Ready and Signed cache recovery,30s wait, exact-byte replay
without resigning and canonical receipt/delivery drain under sender denial.
The Starknet slice covers actual DB/Factory/Lane cold recovery, initial lookup,
Source30/60/120/240s/giveup and missing-hash wait, receipt reconciliation, submitted
N=2/idempotence, actual Control reprocess, message deny and cancellation.

manifest.json records archive hashes; source-status.json.gz records snapshot
drift. Raw JSON mirrors are ignored by exact local paths. No source/global
manifest/docs/hook file was changed and no build/daemon/benchmark was run.
