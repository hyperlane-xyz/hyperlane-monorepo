| Name               | Type                                        | Slot | Offset | Bytes | Contract                      |
| ------------------ | ------------------------------------------- | ---- | ------ | ----- | ----------------------------- |
| \_initialized      | uint8                                       | 0    | 0      | 1     | contracts/Mailbox.sol:Mailbox |
| \_initializing     | bool                                        | 0    | 1      | 1     | contracts/Mailbox.sol:Mailbox |
| \_\_gap            | uint256[50]                                 | 1    | 0      | 1600  | contracts/Mailbox.sol:Mailbox |
| \_owner            | address                                     | 51   | 0      | 20    | contracts/Mailbox.sol:Mailbox |
| \_\_gap            | uint256[49]                                 | 52   | 0      | 1568  | contracts/Mailbox.sol:Mailbox |
| nonce              | uint32                                      | 101  | 0      | 4     | contracts/Mailbox.sol:Mailbox |
| latestDispatchedId | bytes32                                     | 102  | 0      | 32    | contracts/Mailbox.sol:Mailbox |
| defaultIsm         | contract IInterchainSecurityModule          | 103  | 0      | 20    | contracts/Mailbox.sol:Mailbox |
| defaultHook        | contract IPostDispatchHook                  | 104  | 0      | 20    | contracts/Mailbox.sol:Mailbox |
| requiredHook       | contract IPostDispatchHook                  | 105  | 0      | 20    | contracts/Mailbox.sol:Mailbox |
| deliveries         | mapping(bytes32 => struct Mailbox.Delivery) | 106  | 0      | 32    | contracts/Mailbox.sol:Mailbox |
