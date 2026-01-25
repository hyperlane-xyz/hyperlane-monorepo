// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {ERC20Test} from "../test/ERC20Test.sol";

/**
 * @title SimulatedTokenBridge
 * @notice A mock ITokenBridge for simulation testing that:
 *   - Returns configurable fee quotes
 *   - Holds tokens until explicitly completed by the simulation
 *   - Tracks pending transfers for the simulation to query
 *   - Mints destination tokens when completing transfers (simulates cross-chain)
 *
 * This bridge does NOT automatically deliver tokens. The simulation
 * must call `completeTransfer()` after the appropriate delay has passed.
 */
contract SimulatedTokenBridge is ITokenBridge {
    using SafeERC20 for IERC20;

    // ========== State ==========

    IERC20 public immutable token; // Origin token (locked on transfer)
    ERC20Test public destinationToken; // Destination token (minted on complete)
    address public simulator; // Address allowed to complete transfers

    // Fee configuration (can be updated during simulation)
    uint256 public fixedFee;
    uint256 public variableFeeBps; // basis points (10000 = 100%)

    // Pending transfer tracking
    struct PendingTransfer {
        uint32 destination;
        bytes32 recipient;
        uint256 amount;
        uint256 fee;
        uint256 initiatedAt;
        bool completed;
        bool failed;
    }

    mapping(bytes32 => PendingTransfer) public transfers;
    bytes32[] public transferIds;
    uint256 public transferCount;

    // ========== Events ==========

    event TransferInitiated(
        bytes32 indexed transferId,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        uint256 fee
    );

    event TransferCompleted(
        bytes32 indexed transferId,
        address actualRecipient,
        uint256 amount
    );

    event TransferFailed(bytes32 indexed transferId);

    event FeeConfigUpdated(uint256 fixedFee, uint256 variableFeeBps);

    // ========== Constructor ==========

    constructor(
        address _token,
        address _destinationToken,
        address _simulator,
        uint256 _fixedFee,
        uint256 _variableFeeBps
    ) {
        token = IERC20(_token);
        destinationToken = ERC20Test(_destinationToken);
        simulator = _simulator;
        fixedFee = _fixedFee;
        variableFeeBps = _variableFeeBps;
    }

    // ========== Modifiers ==========

    modifier onlySimulator() {
        require(msg.sender == simulator, "Only simulator");
        _;
    }

    // ========== ITokenBridge Implementation ==========

    /**
     * @notice Get quote for transferring tokens to another domain.
     * @param _destination Destination domain ID (unused for fee calc)
     * @param _recipient Recipient address (unused for fee calc)
     * @param _amount Amount to transfer
     * @return quotes Array of quotes (single quote with token fee)
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        // Silence unused variable warnings
        _destination;
        _recipient;

        uint256 fee = calculateFee(_amount);

        quotes = new Quote[](1);
        quotes[0] = Quote(address(token), fee);

        return quotes;
    }

    /**
     * @notice Initiate a transfer to another domain.
     * @dev Tokens are locked in this contract until completeTransfer() is called.
     * @param _destination Destination domain ID
     * @param _recipient Recipient address (bytes32 format)
     * @param _amount Amount to transfer
     * @return transferId Unique identifier for this transfer
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 transferId) {
        uint256 fee = calculateFee(_amount);
        uint256 totalAmount = _amount + fee;

        // Pull tokens from sender (includes fee)
        token.safeTransferFrom(msg.sender, address(this), totalAmount);

        // Generate transfer ID
        transferId = keccak256(
            abi.encode(
                _destination,
                _recipient,
                _amount,
                block.timestamp,
                transferCount
            )
        );

        // Store pending transfer
        transfers[transferId] = PendingTransfer({
            destination: _destination,
            recipient: _recipient,
            amount: _amount,
            fee: fee,
            initiatedAt: block.timestamp,
            completed: false,
            failed: false
        });

        transferIds.push(transferId);
        transferCount++;

        emit TransferInitiated(transferId, _destination, _recipient, _amount, fee);

        return transferId;
    }

    // ========== Simulation Control Functions ==========

    /**
     * @notice Complete a pending transfer by minting destination tokens to recipient.
     * @dev Only callable by the simulator. Mints destination tokens to simulate cross-chain delivery.
     * @param _transferId Transfer to complete
     * @param _actualRecipient Address to receive tokens (converted from bytes32)
     */
    function completeTransfer(
        bytes32 _transferId,
        address _actualRecipient
    ) external onlySimulator {
        PendingTransfer storage t = transfers[_transferId];
        require(t.amount > 0, "Transfer not found");
        require(!t.completed, "Already completed");
        require(!t.failed, "Transfer failed");

        t.completed = true;

        // Mint destination tokens to recipient (simulates cross-chain delivery)
        destinationToken.mintTo(_actualRecipient, t.amount);

        emit TransferCompleted(_transferId, _actualRecipient, t.amount);
    }

    /**
     * @notice Mark a transfer as failed (e.g., for simulating bridge failures).
     * @dev Tokens remain locked in the bridge (could add refund logic).
     * @param _transferId Transfer to mark as failed
     */
    function failTransfer(bytes32 _transferId) external onlySimulator {
        PendingTransfer storage t = transfers[_transferId];
        require(t.amount > 0, "Transfer not found");
        require(!t.completed, "Already completed");
        require(!t.failed, "Already failed");

        t.failed = true;

        emit TransferFailed(_transferId);
    }

    /**
     * @notice Update fee configuration during simulation.
     * @param _fixedFee New fixed fee
     * @param _variableFeeBps New variable fee in basis points
     */
    function setFeeConfig(
        uint256 _fixedFee,
        uint256 _variableFeeBps
    ) external onlySimulator {
        require(_variableFeeBps <= 10000, "Invalid bps");
        fixedFee = _fixedFee;
        variableFeeBps = _variableFeeBps;
        emit FeeConfigUpdated(_fixedFee, _variableFeeBps);
    }

    /**
     * @notice Update simulator address.
     * @param _simulator New simulator address
     */
    function setSimulator(address _simulator) external onlySimulator {
        simulator = _simulator;
    }

    // ========== View Functions ==========

    /**
     * @notice Calculate fee for a given amount.
     */
    function calculateFee(uint256 _amount) public view returns (uint256) {
        return fixedFee + (_amount * variableFeeBps) / 10000;
    }

    /**
     * @notice Get pending transfer details.
     */
    function getTransfer(
        bytes32 _transferId
    ) external view returns (PendingTransfer memory) {
        return transfers[_transferId];
    }

    /**
     * @notice Get all pending (not completed, not failed) transfer IDs.
     */
    function getPendingTransferIds() external view returns (bytes32[] memory) {
        uint256 pendingCount = 0;
        for (uint256 i = 0; i < transferIds.length; i++) {
            PendingTransfer storage t = transfers[transferIds[i]];
            if (!t.completed && !t.failed) {
                pendingCount++;
            }
        }

        bytes32[] memory pending = new bytes32[](pendingCount);
        uint256 j = 0;
        for (uint256 i = 0; i < transferIds.length; i++) {
            PendingTransfer storage t = transfers[transferIds[i]];
            if (!t.completed && !t.failed) {
                pending[j++] = transferIds[i];
            }
        }

        return pending;
    }

    /**
     * @notice Get total fees collected.
     */
    function getCollectedFees() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < transferIds.length; i++) {
            PendingTransfer storage t = transfers[transferIds[i]];
            if (t.completed) {
                total += t.fee;
            }
        }
        return total;
    }
}
