// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {IInbox} from "../../interfaces/arbitrum/IInbox.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArbL1ToL2NativeBridge
 * @notice ITokenBridge adapter for Arbitrum L1→L2 native ETH deposits via the Inbox
 * @dev Used for rebalancing native ETH collateral from L1 to Arbitrum L2
 * @dev L1→L2 ETH deposits on Arbitrum are fast (~10 minutes) and require no additional fees
 * @dev Fully immutable - no admin functions
 * @dev Note: depositEth does NOT invoke the recipient's fallback function on L2
 */
contract ArbL1ToL2NativeBridge is ITokenBridge {
    using TypeCasts for bytes32;
    using Address for address;

    // ============ Events ============

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    // ============ Immutables ============

    /// @notice The Arbitrum Inbox contract on L1
    IInbox public immutable inbox;

    // ============ Constructor ============

    /**
     * @notice Constructor
     * @param _inbox Address of the Arbitrum Inbox contract
     */
    constructor(address _inbox) {
        require(_inbox.isContract(), "Inbox must be a contract");
        inbox = IInbox(_inbox);
    }

    // ============ External Functions ============

    /**
     * @notice Quote the fees for transferring native ETH to L2
     * @dev Arbitrum depositEth requires no additional fees beyond the ETH being deposited
     * @dev Returns the amount as the native quote since the collateral IS native ETH
     * @param _amount Amount of native ETH to transfer
     * @return quotes Array containing the native ETH amount required
     */
    function quoteTransferRemote(
        uint32,
        bytes32,
        uint256 _amount
    ) external pure override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(address(0), _amount);
        return quotes;
    }

    /**
     * @notice Transfer native ETH from L1 to L2 via the Arbitrum Inbox
     * @param _destination Unused (destination is determined by the inbox)
     * @param _recipient Recipient address on L2
     * @param _amount Amount of native ETH to transfer
     * @return transferId Always returns bytes32(0) as native bridges don't provide message IDs
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 transferId) {
        require(_amount > 0, "Amount must be greater than 0");
        require(msg.value >= _amount, "Insufficient native token");

        address recipient = _recipient.bytes32ToAddress();

        // Deposit native ETH to L2 via the Inbox
        inbox.depositEth{value: _amount}(recipient);

        emit SentTransferRemote(_destination, _recipient, _amount);

        return bytes32(0);
    }
}
