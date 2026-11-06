# Aleo worker Linux lifecycle correction

Actual Linux/arm64 SDK image execution exposed two worker issues. The network
sandbox correctly denied sockets with `EPERM`, but Zig 0.15.2's POSIX socket
wrapper maps that errno to `Unexpected`. The explicit worker network probe now
checks the Linux socket syscall's `EPERM`/`EACCES` directly. Other failures remain
errors; a successful diagnostic socket closes before the existing connection
probe. The seccomp filter is unchanged. A real owned loopback connection returns
allowed, while the sandboxed image worker returns blocked. Malformed inputs and
a bound, unlistened Linux port remain negative controls. Darwin queues SYNs on
an unlistened port, so that Linux-specific refusal fixture is excluded there;
both macOS modes retain the actual allowed loopback and invalid-input controls.

Linux `Child.spawn()` can also return before exec. Sampling RSS immediately could
charge a small worker for its parent's inherited pages. A public fixture with a
256 MiB resident parent, 3,000 arguments, and a 48 MiB worker limit reproduced
`AleoWorkerMemoryLimit` inside `Session.spawn`, before the fixture executable
started. The original full SDK run independently exposed this failure after
loading native primitives.

`Session` now waits for Child's exec-error pipe to contain its atomic errno or
close through `CLOEXEC`. Polls use at most 10 ms and the remaining original timer;
cancellation and deadline checks run before and after acknowledgement. RSS checks
then measure the exec image. Error cleanup kills and reaps the child, including
when cancellation races an unread typed exec failure. Clearing Child's cached
spawn error lets its normal wait close every pipe and collect the process.

The focused regressions cover inherited RSS, actual post-exec memory exhaustion,
missing and nonexecutable paths, file-descriptor/child-list equality, late control
failure over a ready exec-error pipe, and cancellation/deadline over a pending
acknowledgement. The existing proof, pipe-bound, cancellation, and memory assertions
remain. Debug, ReleaseSafe, and ReleaseFast focused runs pass; the 75 selected
actual-SDK Aleo tests pass in both release modes as UID 10001, including offline
execution/fee proofs and the OS network sandbox.

Evidence is archived under
[`aleo-worker-linux-lifecycle`](../../zig/bench/results/aleo-worker-linux-lifecycle/manifest.json.gz).
The initial image failures and corrected harness configuration are retained.
Python is installed only in the disposable test layer for the existing fake-worker
fixture. Runtime images retain their original minimal package boundary. The
canonical container acceptance records the rebuilt worker and final image IDs;
the diagnostic fixed-worker binary alone is not an image acceptance claim.
