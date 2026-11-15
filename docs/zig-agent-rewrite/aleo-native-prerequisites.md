# Aleo native startup prerequisites

The immutable amd64 tools image was acquired through the explicitly selected local OrbStack daemon. The isolated version check printed Leo4.3.2. A separate network-isolated, read-only-root devnode container reached the actual Source startup marker while running, using the existing public fixture environment. Root stopped and removed both exact owned containers. No host ports were published for the standalone health check.

The devnode had a3GiB memory limit,2CPU limit and1GiB temporary filesystem. Recorded startup samples reached38.44MiB in its first7.7seconds; these are neither proving memory nor a whole-run peak. The guest capacity readback and host free-space checks are dated observations, not future reservations.

The image pull itself returned0. Its parent runner failed a later assertion that assumed the image ID equals the config digest. Actual containerd inspection uses the manifest digest as image ID. The preserved corrected readback binds the immutable manifest and explicitly records that raw in-memory pull monitor samples were lost. No repeated pull or unrelated image/container cleanup was performed.

[Lossless packet](../../zig/bench/results/aleo-image-startup-prerequisites/manifest.json) contains39gzip members,102145raw bytes and33604compressed bytes. It retains the original assertion failure, corrected readback, actual plans/commands/logs, startup samples and owned cleanup receipts. Historical capacity inventory statements reflect their original read time.

SDK deployment, consensus/proof compatibility, real validator/relayer/scraper execution, canonical native receipts, PostgreSQL, retained-row restart and600-second acceptance remain required. No benchmark result is inferred from startup duration.
