# CCIP Read ISM's

CCIP Read ISM's allow for submission of data verified by arbitrary groups of third party signers. CCIP Read ISM's are so powerful because these third party signers do not need to be aware of Hyperlane.

## Deployment

To deploy your own CCIP Read ISM you will need a few things,

1. An endpoint that provides the data and aggregates signatures over it
2. A custom smart contract that extends the AbstractCcipReadIsm. This contract needs to handle saving data and also expose functions for querying accepted data
3.
