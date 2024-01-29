// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "../middleware/libs/Call.sol";

interface IInterchainQueryRouter{

    /**
     * @notice Dispatches a sequence of static calls (query) to the destination domain and set of callbacks to resolve the results on the dispatcher.
     * @param _destination The domain of the chain to query.
     * @param _to The address of the contract to query
     * @param _data The calldata encoding the query
     * @param _callback The calldata of the callback that will be made on the sender.
     * The return value of the query will be appended.
     * @dev Callbacks must be returned to the `msg.sender` for security reasons. Require this contract is the `msg.sender` on callbacks.
     */
    function query(
        uint32 _destination,
        address _to,
        bytes memory _data,
        bytes memory _callback
    ) external returns (bytes32);

    /**
     * @notice Dispatches a sequence of static calls (query) to the destination domain and set of callbacks to resolve the results on the dispatcher.
     * @param _destination The domain of the chain to query.
     * @param calls The sequence of static calls to dispatch and callbacks on the sender to resolve the results.
     * @dev Recommend using CallLib.build to format the interchain calls.
     * @dev Callbacks must be returned to the `msg.sender` for security reasons. Require this contract is the `msg.sender` on callbacks.
     */
    function query(
        uint32 _destination,
        CallLib.StaticCallWithCallback[] calldata calls
    ) external returns (bytes32);

}
