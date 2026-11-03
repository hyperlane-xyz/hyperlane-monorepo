| Workload                  | Before p50/p95 ms | After p50/p95 ms | p50 ratio | Requests before/after | Peak before/after |
| ------------------------- | ----------------: | ---------------: | --------: | --------------------: | ----------------: |
| blocks/straggler          |   334.912/340.009 |    61.219/64.958 |     5.47x |                 32/32 |               1/8 |
| blocks/uniform            |   234.246/237.847 |    30.297/31.599 |     7.73x |                 32/32 |               1/8 |
| blocks/zero               |       0.090/0.113 |      0.094/0.115 |     0.96x |                 32/32 |               1/1 |
| multisig_quorum/straggler |     61.390/65.091 |    23.820/30.423 |     2.58x |                   7/7 |               4/4 |
| multisig_quorum/uniform   |     14.470/15.907 |    14.308/15.621 |     1.01x |                   4/4 |               4/4 |
| multisig_quorum/zero      |       3.384/3.520 |      3.397/3.616 |     1.00x |                   3/3 |               1/1 |
| transactions/straggler    |   335.786/342.728 |    59.328/65.715 |     5.66x |                 32/32 |               1/8 |
| transactions/uniform      |   235.855/239.583 |    30.920/31.968 |     7.63x |                 32/32 |               1/8 |
| transactions/zero         |       0.349/0.627 |      0.396/0.667 |     0.88x |                 32/32 |               1/1 |
