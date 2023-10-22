// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IOptimisticIsm is IInterchainSecurityModule {
	error OnlyWatcherError();
    error ThresholdTooLarge();
    
    event SetSubmodule(IInterchainSecurityModule indexed submodule);
    event SetFraudWindow(uint64 indexed fraudWindow);
    event FraudulentISM(IInterchainSecurityModule indexed submodule, address watcher);
    event WatcherAdded(address indexed watcher);
    event ThresholdSet(uint256 indexed threshold);

    function preVerify(bytes calldata _metadata, bytes calldata _message) external returns (bool);
	function markFraudulent(IInterchainSecurityModule _submodule) external;
	function submodule(bytes calldata _message) external view returns (IInterchainSecurityModule);
}
