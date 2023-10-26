// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";
import {StaticOptimisticWatchers} from "../../isms/optimistic/StaticOptimisticWatchers.sol";

interface IOptimisticIsm is IInterchainSecurityModule {
	
    /// @notice Thrown when a function is called by an address not in the watchers set
    error OnlyWatcher();

    /// @notice Thrown when a submodule is invalid (non of type OPTIMISTIC)
    error InvalidSubmodule();

    /// @notice Thrown when a submodule is already marked as fraudulent by a watcher
    error AlreadyMarkedFraudulent();
    
    /// @notice Emitted when a new submodule is set
    event SetSubmodule(IInterchainSecurityModule indexed submodule);

    /// @notice Emitted when a submodule is marked as fraudulent
    event SetFraudWindow(uint64 indexed fraudWindow);

    /// @notice Emitted when a submodule is marked as fraudulent
    event FraudulentISM(IInterchainSecurityModule indexed submodule, address watcher);

    /// @notice Emitted when a message has been pre-verified
    event PreVerified(bytes32 id);

    /// @notice The initial step of the OptimisticISM verification process
    /// @param _metadata The metadata of the message
    /// @param _message The message to verify
    function preVerify(bytes calldata _metadata, bytes calldata _message) external returns (bool);
	
    /// @notice Marks a submodule as fraudulent
    /// @param _fraudulantSubmodule The submodule to mark as fraudulent
    function markFraudulent(IInterchainSecurityModule _fraudulantSubmodule) external;
	
    /// @notice Returns the current submodule used to verify messages
    function submodule(bytes calldata _message) external view returns (IInterchainSecurityModule);
}
