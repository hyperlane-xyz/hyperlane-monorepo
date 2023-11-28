| Name                  | Type                                                             | Slot | Offset | Bytes | Contract                                                              |
| --------------------- | ---------------------------------------------------------------- | ---- | ------ | ----- | --------------------------------------------------------------------- |
| \_initialized         | uint8                                                            | 0    | 0      | 1     | contracts/hooks/igp/InterchainGasPaymaster.sol:InterchainGasPaymaster |
| \_initializing        | bool                                                             | 0    | 1      | 1     | contracts/hooks/igp/InterchainGasPaymaster.sol:InterchainGasPaymaster |
| \_\_gap               | uint256[50]                                                      | 1    | 0      | 1600  | contracts/hooks/igp/InterchainGasPaymaster.sol:InterchainGasPaymaster |
| \_owner               | address                                                          | 51   | 0      | 20    | contracts/hooks/igp/InterchainGasPaymaster.sol:InterchainGasPaymaster |
| \_\_gap               | uint256[49]                                                      | 52   | 0      | 1568  | contracts/hooks/igp/InterchainGasPaymaster.sol:InterchainGasPaymaster |
| destinationGasConfigs | mapping(uint32 => struct InterchainGasPaymaster.DomainGasConfig) | 101  | 0      | 32    | contracts/hooks/igp/InterchainGasPaymaster.sol:InterchainGasPaymaster |
| beneficiary           | address                                                          | 102  | 0      | 20    | contracts/hooks/igp/InterchainGasPaymaster.sol:InterchainGasPaymaster |
