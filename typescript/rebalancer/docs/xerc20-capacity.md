# xERC20 inventory capacity

Lockbox collateral remains the wrapped-token balance held by the lockbox. Temporary mint/burn capacity does not change strategy targets or invent a collateral deficit.

Inventory execution separately checks the physical `transferRemote` sender's burn capacity and receiver's mint capacity. This direction is opposite to the economic collateral proposal. Pending inventory deposits reserve capacity, and same-asset token fees reduce the burn budget. Velo tokens also respect their per-transfer mint ceiling. Capacity is checked again before transaction construction.

Zero or uneconomic capacity waits for a later cycle; it does not trigger more inventory sourcing or complete the intent. Shared lockbox collateral and rate limits can change before a message arrives, so these checks do not reserve capacity on-chain or guarantee immediate user/message delivery. Conservative reservations can temporarily underutilize a limit already consumed by a pending transfer.

A residual intent below the existing economic transfer threshold completes before querying capacity. A meaningful remainder never completes merely because current capacity is small. Once capacity is viable, external funding targets the whole remaining intent plus costs/buffer; unused funds stay in signer inventory for later capacity-sized deposits. This intentionally trades temporary parked inventory for fewer external bridge operations and fixed fees.
