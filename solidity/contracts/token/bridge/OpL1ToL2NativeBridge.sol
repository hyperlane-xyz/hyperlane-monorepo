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
import {IStandardBridge} from "../../interfaces/optimism/IStandardBridge.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OpL1ToL2NativeBridge
 * @notice ITokenBridge adapter for OP Stack L1→L2 native ETH deposits via the Standard Bridge
 * @dev Used for rebalancing native ETH collateral from L1 to OP Stack L2s
 * @dev L1→L2 deposits on OP Stack are fast (~1-3 minutes) and subsidized by the sequencer
 * @dev Fully immutable - no admin functions
 */
contract OpL1ToL2NativeBridge is ITokenBridge {
    using TypeCasts for bytes32;
    using Address for address;

    // ============ Events ============

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    // ============ Constants ============

    /// @notice Minimum gas limit for L2 execution of the deposit
    uint32 public constant MIN_GAS_LIMIT = 100_000;

    // ============ Immutables ============

    /// @notice The OP Stack L1 Standard Bridge contract
    IStandardBridge public immutable l1Bridge;

    // ============ Constructor ============

    /**
     * @notice Constructor
     * @param _l1Bridge Address of the OP Stack L1 Standard Bridge
     */
    constructor(address _l1Bridge) {
        require(_l1Bridge.isContract(), "L1 bridge must be a contract");
        l1Bridge = IStandardBridge(payable(_l1Bridge));
    }

    // ============ External Functions ============

    /**
     * @notice Quote the fees for transferring native ETH to L2
     * @dev OP Stack L1→L2 deposits are subsidized by the sequencer, so no additional fee is required
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
     * @notice Transfer native ETH from L1 to L2 via the OP Stack Standard Bridge
     * @param _destination Unused (destination is determined by the bridge)
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

        // Bridge native ETH to L2 via the Standard Bridge
        l1Bridge.bridgeETHTo{value: _amount}(recipient, MIN_GAS_LIMIT, "");

        emit SentTransferRemote(_destination, _recipient, _amount);

        return bytes32(0);
    }
}
