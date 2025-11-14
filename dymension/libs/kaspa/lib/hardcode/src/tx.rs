pub const DUST_AMOUNT: u64 = 20_000_001;

// Kaspa sweeping PSKT generator incorrectly computes TX fee if there is one party in the multisig.
// Add this small priproty fee to every sweeping TX to ensure the sufficient fee even if there
// is one validator. 3_000 is a magic number.
// TODO: make it configurable?
pub const RELAYER_SWEEPING_PRIORITY_FEE: u64 = 3_000;

// Only sweep is the threshold is exceeded. It doesn't make sense to sweep less UTXOs.
// The value is the total number of UTXOs including the anchor UTXO.
// TODO: make it configurable?
pub const SWEEPING_THRESHOLD: usize = 3;

/*
In Kaspa, every node has a different and eventually converging view of the network.
Nodes run a local algorithm where they connect gossiped blocks in a DAG. The DAG has a set of blue blocks and a set of red blocks.
A TX can be contained in one or more blocks, but will not take effect on the state machine unless it is contained in a blue block, or
it's contained in a red block which is an ancestor of a blue block. Such a blue block is called the accepting block.

A TX can appear to be accepted on a node but may be reorged if the node's view of the network changes. This can happen if a different
fork becomes heavier (has more blue blocks in its DAG). Therefore the way to ensure a low probability of reorg is to ensure that
- the accepting block is an ancestor of the current DAG 'tip' (where tip is a virtual block connected to all dangling blue blocks)
- the tip has a sufficiently higher blue score than the accepting block

The REST API takes care of maintaining an up to date view of the network. It can tell us the blue score of the accepting block of a TX
as well as the current blue score of the tip. We numerically compare these to determine if the TX is final, where final means will
reorg with an acceptably low probability.


Probabilities:
- The numbers here are a combination of GPT and advice from discord, the true numbers can be derived from network parameters (K=124)
- Kucoin centralized exchange uses 1000 confirmations for Kaspa deposits (source Discord)
- 100-200 confirmations is suitable (source Discord)


Blue Score Difference (d)	Time Elapsed (Approx)	Upper Bound on Reorg Probability (vs 33% attacker)	Security Level
10	                          1 second	             < 56%	                                            Very Low
100	                          10 seconds	         < 0.31%	                                        Low (Comparable to 1-2 Bitcoin confirmations)
200	                          20 seconds	         < 0.00095% (9.5 x 10^-6)	                        Moderate (Comparable to 6 Bitcoin confirmations)
1,000	                      ~1.7 minutes	         < 8.8 x 10^-26	                                    Extremely High (Far exceeds typical blockchain finality)
6,000	                      10 minutes	         < 2.8 x 10^-151	                                Effectively Absolute / Cryptographically Final

We choose 1000, which is probably over conservative.
 */
pub const REQUIRED_FINALITY_BLUE_SCORE_CONFIRMATIONS: i64 = 1000;

// Maximum number of inputs to include in a sweeping bundle.
pub const MAX_SWEEP_INPUTS: usize = 1000;

pub const MAX_MASS_MARGIN: f64 = 0.9; // 90% of the max mass
