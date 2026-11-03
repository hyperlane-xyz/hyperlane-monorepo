# Measured Lander comparisons

Controlled adapter-boundary stress, not end-to-end per-chain pipeline throughput; InclusionStage intentionally awaits transaction mutations serially.

The main tables pre-admit 32 operations directly to the adapter. They bypass InclusionStage's serialized transaction-mutation loop. Ops/s below means adapter operations/s, not deployed per-chain pipeline throughput.

Values are baseline → proposed. All times are milliseconds unless marked otherwise.

| Case               | Scenario  |              Batch p50 |              Batch p95 |        Operation p50 |          Operation p95 |       Adapter ops/s |
| ------------------ | --------- | ---------------------: | ---------------------: | -------------------: | ---------------------: | ------------------: |
| svm_submit         | uniform   |  140.746000 → 9.202958 | 144.266167 → 10.226208 | 72.203250 → 5.671208 |  135.780375 → 9.992750 |      227.9 → 3524.0 |
| svm_submit         | straggler | 162.971208 → 23.910334 | 169.400750 → 25.434917 | 94.675667 → 7.943375 | 157.919666 → 13.002584 |      196.9 → 1344.7 |
| svm_submit         | no_io     |    0.103084 → 0.104250 |    0.115333 → 0.118667 |  0.055667 → 0.059834 |    0.101875 → 0.103917 | 304415.5 → 298599.8 |
| svm_prepare_submit | uniform   |    4.868541 → 9.601500 |    5.319500 → 9.929958 |  4.752333 → 5.089292 |    5.149417 → 9.815458 |     6727.3 → 3460.3 |
| svm_prepare_submit | straggler |  26.026542 → 24.475875 |  29.511750 → 26.032417 |  4.938541 → 8.142583 |   5.265666 → 13.405834 |     1230.1 → 1336.9 |
| svm_prepare_submit | no_io     |    0.142167 → 0.107750 |    0.154583 → 0.122375 |  0.077750 → 0.061417 |    0.140083 → 0.107459 | 221280.3 → 287935.2 |
| evm_gas            | uniform   |    9.732875 → 5.170125 |   10.692500 → 6.055333 |  9.444042 → 4.958417 |   10.496417 → 5.825209 |     3338.0 → 6333.1 |
| evm_gas            | straggler |  29.631708 → 26.136333 |  32.244625 → 28.967209 |  9.131417 → 5.036958 |   10.668625 → 6.061209 |     1091.9 → 1230.4 |
| evm_gas            | no_io     |    0.288000 → 0.287250 |    0.295083 → 0.300667 |  0.151958 → 0.152750 |    0.278333 → 0.278792 | 110835.3 → 110100.6 |
| evm_payload        | uniform   |  141.198541 → 9.588000 | 144.937208 → 10.598875 | 72.828875 → 6.259333 | 136.145750 → 10.404125 |      226.8 → 3342.3 |
| evm_payload        | straggler | 163.668458 → 24.728875 | 169.719375 → 26.677166 | 95.604625 → 8.169500 | 158.962333 → 13.875084 |      195.6 → 1302.0 |
| evm_payload        | no_io     |    0.199083 → 0.207375 |    0.210459 → 0.216375 |  0.153625 → 0.158792 |    0.196292 → 0.202750 | 158140.5 → 151103.5 |

CPU is mean whole-process CPU per pass, including setup/warm-ups/fixtures/output. RSS is max process peak across passes.

| Case               | Scenario  | Peak in-flight | Calls/batch |   CPU ms/pass |  Peak RSS MiB | Retained entries |
| ------------------ | --------- | -------------: | ----------: | ------------: | ------------: | ---------------: |
| svm_submit         | uniform   |         1 → 16 |          96 | 305.0 → 130.0 | 18.36 → 18.47 |            0 → 0 |
| svm_submit         | straggler |         1 → 16 |          96 | 305.0 → 130.0 | 18.34 → 18.50 |            0 → 0 |
| svm_submit         | no_io     |          1 → 1 |          96 | 250.0 → 230.0 | 20.84 → 20.98 |            0 → 0 |
| svm_prepare_submit | uniform   |        32 → 16 |          96 |  85.0 → 120.0 | 18.55 → 18.47 |         1696 → 0 |
| svm_prepare_submit | straggler |        32 → 16 |          96 | 130.0 → 135.0 | 18.62 → 18.53 |         1696 → 0 |
| svm_prepare_submit | no_io     |          1 → 1 |          96 | 285.0 → 230.0 | 22.73 → 20.98 |        33600 → 0 |
| evm_gas            | uniform   |        32 → 64 |          64 | 120.0 → 120.0 | 18.88 → 19.05 |                — |
| evm_gas            | straggler |        32 → 64 |          64 | 175.0 → 155.0 | 18.88 → 19.11 |                — |
| evm_gas            | no_io     |          1 → 1 |          64 | 385.0 → 380.0 | 21.19 → 21.31 |                — |
| evm_payload        | uniform   |         1 → 16 |          32 | 325.0 → 160.0 | 19.38 → 19.56 |                — |
| evm_payload        | straggler |         1 → 16 |          32 | 335.0 → 190.0 | 19.38 → 19.53 |                — |
| evm_payload        | no_io     |          1 → 1 |          32 | 430.0 → 430.0 | 21.89 → 22.02 |                — |

## Fresh-path controls below the estimate cap

Same binary/provider/ABBA protocol, uniform delay. These remain adapter controls, not complete InclusionStage pipeline measurements.

| Width |           Batch p50 |           Batch p95 |       Operation p95 | Peak in-flight | Calls/batch | Retained entries |
| ----: | ------------------: | ------------------: | ------------------: | -------------: | ----------: | ---------------: |
|     1 | 4.564625 → 4.560500 | 4.637375 → 4.653667 | 4.636500 → 4.652292 |          1 → 1 |           3 |           53 → 0 |
|     8 | 4.654042 → 4.647750 | 4.904875 → 4.836084 | 4.829208 → 4.788209 |          8 → 8 |          24 |          424 → 0 |
