// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IBurner} from "../../../interfaces/network/slasher/IBurner.sol";

interface IBurnerRouter is IBurner {
    error AlreadySet();
    error DuplicateNetworkReceiver();
    error DuplicateOperatorNetworkReceiver();
    error InsufficientBalance();
    error InvalidCollateral();
    error InvalidReceiver();
    error InvalidReceiverSetEpochsDelay();
    error NotReady();

    /**
     * @notice Structure for a value of `address` type.
     * @param value value of `address` type
     */
    struct Address {
        address value;
    }

    /**
     * @notice Structure for a pending value of `address` type.
     * @param value pending value of `address` type
     * @param timestamp timestamp since which the pending value can be used
     */
    struct PendingAddress {
        address value;
        uint48 timestamp;
    }

    /**
     * @notice Structure for a value of `uint48` type.
     * @param value value of `uint48` type
     */
    struct Uint48 {
        uint48 value;
    }

    /**
     * @notice Structure for a pending value of `uint48` type.
     * @param value pending value of `uint48` type
     * @param timestamp timestamp since which the pending value can be used
     */
    struct PendingUint48 {
        uint48 value;
        uint48 timestamp;
    }

    /**
     * @notice Structure used to set a `receiver` for a slashing `network`.
     * @param network address of the slashing network
     * @param receiver address of the recipient of the slashed funds
     */
    struct NetworkReceiver {
        address network;
        address receiver;
    }

    /**
     * @notice Structure used to set a `receiver` for a slashed `operator` by a slashing `network`.
     * @param network address of the slashing network
     * @param operator address of the slashed operator
     * @param receiver address of the recipient of the slashed funds
     */
    struct OperatorNetworkReceiver {
        address network;
        address operator;
        address receiver;
    }

    /**
     * @notice Initial parameters needed for a router deployment.
     * @param owner manager of the router's receivers
     * @param collateral router's underlying collateral (MUST be the same as the vault's underlying collateral)
     * @param delay delay for setting a new receiver or changing the delay itself (in seconds)
     * @param globalReceiver address of the global receiver of the slashed funds (if no receiver is set for a network or operator)
     * @param networkReceivers array of network receivers to set on deployment (network => receiver)
     * @param operatorNetworkReceivers array of operator network receivers to set on deployment (network-operator => receiver)
     */
    struct InitParams {
        address owner;
        address collateral;
        uint48 delay;
        address globalReceiver;
        NetworkReceiver[] networkReceivers;
        OperatorNetworkReceiver[] operatorNetworkReceivers;
    }

    /**
     * @notice Emitted when a transfer from the router to the receiver is triggered.
     * @param receiver address of the receiver
     * @param amount amount of the transfer
     */
    event TriggerTransfer(address indexed receiver, uint256 amount);

    /**
     * @notice Emitted when a global receiver is set (becomes pending for a `delay`).
     * @param receiver address of the receiver
     */
    event SetGlobalReceiver(address receiver);

    /**
     * @notice Emitted when a pending global receiver is accepted.
     */
    event AcceptGlobalReceiver();

    /**
     * @notice Emitted when a network receiver is set (becomes pending for a `delay`).
     * @param network address of the network
     * @param receiver address of the receiver
     */
    event SetNetworkReceiver(address indexed network, address receiver);

    /**
     * @notice Emitted when a pending network receiver is accepted.
     * @param network address of the network
     */
    event AcceptNetworkReceiver(address indexed network);

    /**
     * @notice Emitted when an operator network receiver is set (becomes pending for a `delay`).
     * @param network address of the network
     * @param operator address of the operator
     * @param receiver address of the receiver
     */
    event SetOperatorNetworkReceiver(
        address indexed network,
        address indexed operator,
        address receiver
    );

    /**
     * @notice Emitted when a pending operator network receiver is accepted.
     * @param network address of the network
     * @param operator address of the operator
     */
    event AcceptOperatorNetworkReceiver(
        address indexed network,
        address indexed operator
    );

    /**
     * @notice Emitted when a delay is set (becomes pending for a `delay`).
     * @param delay new delay
     */
    event SetDelay(uint48 delay);

    /**
     * @notice Emitted when a pending delay is accepted.
     */
    event AcceptDelay();

    /**
     * @notice Get a router collateral.
     * @return address of the underlying collateral
     */
    function collateral() external view returns (address);

    /**
     * @notice Get a router last checked balance.
     * @return last balance of the router
     */
    function lastBalance() external view returns (uint256);

    /**
     * @notice Get a router delay.
     * @return delay for setting a new receiver or changing the delay itself (in seconds)
     */
    function delay() external view returns (uint48);

    /**
     * @notice Get a router pending delay.
     * @return value pending delay
     * @return timestamp timestamp since which the pending delay can be used
     */
    function pendingDelay() external view returns (uint48, uint48);

    /**
     * @notice Get a router global receiver.
     * @return address of the global receiver of the slashed funds
     */
    function globalReceiver() external view returns (address);

    /**
     * @notice Get a router pending global receiver.
     * @return value pending global receiver
     * @return timestamp timestamp since which the pending global receiver can be used
     */
    function pendingGlobalReceiver() external view returns (address, uint48);

    /**
     * @notice Get a router receiver for a slashing network.
     * @param network address of the slashing network
     * @return address of the receiver
     */
    function networkReceiver(address network) external view returns (address);

    /**
     * @notice Get a router pending receiver for a slashing network.
     * @param network address of the slashing network
     * @return value pending receiver
     * @return timestamp timestamp since which the pending receiver can be used
     */
    function pendingNetworkReceiver(
        address network
    ) external view returns (address, uint48);

    /**
     * @notice Get a router receiver for a slashed operator by a slashing network.
     * @param network address of the slashing network
     * @param operator address of the slashed operator
     * @return address of the receiver
     */
    function operatorNetworkReceiver(
        address network,
        address operator
    ) external view returns (address);

    /**
     * @notice Get a router pending receiver for a slashed operator by a slashing network.
     * @param network address of the slashing network
     * @param operator address of the slashed operator
     * @return value pending receiver
     * @return timestamp timestamp since which the pending receiver can be used
     */
    function pendingOperatorNetworkReceiver(
        address network,
        address operator
    ) external view returns (address, uint48);

    /**
     * @notice Get a receiver balance of unclaimed collateral.
     * @param receiver address of the receiver
     * @return amount of the unclaimed collateral tokens
     */
    function balanceOf(address receiver) external view returns (uint256);

    /**
     * @notice Trigger a transfer of the unclaimed collateral to the receiver.
     * @param receiver address of the receiver
     * @return amount of the transfer
     */
    function triggerTransfer(
        address receiver
    ) external returns (uint256 amount);

    /**
     * @notice Set a new global receiver of the slashed funds.
     * @param receiver address of the new receiver
     */
    function setGlobalReceiver(address receiver) external;

    /**
     * @notice Accept a pending global receiver.
     */
    function acceptGlobalReceiver() external;

    /**
     * @notice Set a new receiver for a slashing network.
     * @param network address of the slashing network
     * @param receiver address of the new receiver
     */
    function setNetworkReceiver(address network, address receiver) external;

    /**
     * @notice Accept a pending receiver for a slashing network.
     * @param network address of the slashing network
     */
    function acceptNetworkReceiver(address network) external;

    /**
     * @notice Set a new receiver for a slashed operator by a slashing network.
     * @param network address of the slashing network
     * @param operator address of the slashed operator
     * @param receiver address of the new receiver
     */
    function setOperatorNetworkReceiver(
        address network,
        address operator,
        address receiver
    ) external;

    /**
     * @notice Accept a pending receiver for a slashed operator by a slashing network.
     * @param network address of the slashing network
     * @param operator address of the slashed operator
     */
    function acceptOperatorNetworkReceiver(
        address network,
        address operator
    ) external;

    /**
     * @notice Set a new delay for setting a new receiver or changing the delay itself.
     * @param newDelay new delay (in seconds)
     */
    function setDelay(uint48 newDelay) external;

    /**
     * @notice Accept a pending delay.
     */
    function acceptDelay() external;
}
