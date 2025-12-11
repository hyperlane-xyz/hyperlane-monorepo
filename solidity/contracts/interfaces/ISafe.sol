// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// source: https://github.com/safe-global/safe-smart-account/blob/d9fdda990c3ff5279edfea03c1fd377abcb39b38/contracts/interfaces/IOwnerManager.sol
interface IOwnerManager {
    /**
     * @notice Returns the number of required confirmations for a Safe transaction aka the threshold.
     * @return Threshold number.
     */
    function getThreshold() external view returns (uint256);
}

interface ISafe is IOwnerManager {
    enum Operation {
        Call,
        DelegateCall
    }

    /**
     * @notice Returns the nonce of the Safe contract.
     * @return Nonce.
     */
    function nonce() external view returns (uint256);

    /**
     * @notice Executes a Safe transaction.
     * @param to Destination address.
     * @param value Ether value.
     * @param data Data payload.
     * @param operation Operation type (Call or DelegateCall).
     * @param safeTxGas Gas that should be used for the Safe transaction.
     * @param baseGas Gas costs for data used to trigger the safe transaction.
     * @param gasPrice Maximum gas price that should be used for this transaction.
     * @param gasToken Token address (or 0 if ETH) that is used for the payment.
     * @param refundReceiver Address of receiver of gas payment (or 0 if tx.origin).
     * @param signatures Signature data that should be verified.
     * @return success Boolean indicating transaction's success.
     */
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool success);

    /**
     * @notice Marks a hash as approved.
     * @param hashToApprove The hash to mark as approved for signatures.
     */
    function approveHash(bytes32 hashToApprove) external;

    /**
     * @notice Adds an owner to the Safe and updates the threshold.
     * @param owner New owner address.
     * @param _threshold New threshold.
     */
    function addOwnerWithThreshold(address owner, uint256 _threshold) external;

    /**
     * @notice Removes an owner from the Safe and updates the threshold.
     * @param prevOwner Owner that pointed to the owner to be removed in the linked list.
     * @param owner Owner address to be removed.
     * @param _threshold New threshold.
     */
    function removeOwner(
        address prevOwner,
        address owner,
        uint256 _threshold
    ) external;

    /**
     * @notice Replaces an owner with a new owner.
     * @param prevOwner Owner that pointed to the owner to be replaced in the linked list.
     * @param oldOwner Owner address to be replaced.
     * @param newOwner New owner address.
     */
    function swapOwner(
        address prevOwner,
        address oldOwner,
        address newOwner
    ) external;

    /**
     * @notice Changes the threshold of the Safe.
     * @param _threshold New threshold.
     */
    function changeThreshold(uint256 _threshold) external;

    /**
     * @notice Enables a Safe module.
     * @param module Module to be enabled.
     */
    function enableModule(address module) external;

    /**
     * @notice Disables a Safe module.
     * @param prevModule Module that pointed to the module to be removed in the linked list.
     * @param module Module to be removed.
     */
    function disableModule(address prevModule, address module) external;

    /**
     * @notice Sets a guard that checks transactions before execution.
     * @param guard The address of the guard to be used or the 0 address to disable the guard.
     */
    function setGuard(address guard) external;

    /**
     * @notice Sets the fallback handler.
     * @param handler The address of the handler.
     */
    function setFallbackHandler(address handler) external;

    /**
     * @notice Executes a transaction from an enabled module.
     * @param to Destination address.
     * @param value Ether value.
     * @param data Data payload.
     * @param operation Operation type.
     * @return success Boolean indicating transaction's success.
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success);

    /**
     * @notice Executes a transaction from an enabled module and returns data.
     * @param to Destination address.
     * @param value Ether value.
     * @param data Data payload.
     * @param operation Operation type.
     * @return success Boolean indicating transaction's success.
     * @return returnData Return data from the transaction.
     */
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success, bytes memory returnData);

    /**
     * @notice Sets up the Safe with owners, threshold, and optional initial configuration.
     * @param _owners List of Safe owners.
     * @param _threshold Number of required confirmations for a Safe transaction.
     * @param to Contract address for optional delegate call.
     * @param data Data payload for optional delegate call.
     * @param fallbackHandler Handler for fallback calls to this contract.
     * @param paymentToken Token that should be used for the payment (0 is ETH).
     * @param payment Value that should be paid.
     * @param paymentReceiver Address that should receive the payment (or 0 if tx.origin).
     */
    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    /**
     * @notice Simulates a transaction and reverts with the return data.
     * @param targetContract Address of the contract to simulate.
     * @param calldataPayload Calldata to be used in the simulation.
     */
    function simulateAndRevert(
        address targetContract,
        bytes calldata calldataPayload
    ) external;
}
