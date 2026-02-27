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

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OpL1ToL2ERC20Bridge
 * @notice ITokenBridge adapter for OP Stack L1→L2 ERC20 deposits via the Standard Bridge
 * @dev Used for rebalancing collateral from L1 to OP Stack L2s (Optimism, Base, etc.)
 * @dev L1→L2 deposits on OP Stack are fast (~1-3 minutes) and gas is subsidized by the sequencer
 */
contract OpL1ToL2ERC20Bridge is ITokenBridge {
    using SafeERC20 for IERC20;
    using TypeCasts for bytes32;
    using Address for address;

    // ============ Events ============

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    // ============ Immutables ============

    /// @notice The OP Stack L1 Standard Bridge contract
    IStandardBridge public immutable l1Bridge;

    /// @notice The L1 ERC20 token this bridge handles
    address public immutable localToken;

    /// @notice The corresponding L2 token address (OptimismMintableERC20)
    address public immutable remoteToken;

    // ============ Constants ============

    /// @notice Minimum gas limit for L2 finalizeBridgeERC20 execution
    uint32 public constant MIN_GAS_LIMIT = 100_000;

    // ============ Constructor ============

    /**
     * @notice Constructor
     * @param _l1Bridge Address of the OP Stack L1 Standard Bridge
     * @param _localToken Address of the L1 ERC20 token
     * @param _remoteToken Address of the corresponding L2 token
     */
    constructor(address _l1Bridge, address _localToken, address _remoteToken) {
        require(_l1Bridge.isContract(), "L1 bridge must be a contract");
        require(_localToken.isContract(), "Local token must be a contract");
        require(_remoteToken != address(0), "Remote token cannot be zero");

        l1Bridge = IStandardBridge(payable(_l1Bridge));
        localToken = _localToken;
        remoteToken = _remoteToken;

        // Approve the bridge to spend tokens
        IERC20(_localToken).forceApprove(_l1Bridge, type(uint256).max);
    }

    // ============ External Functions ============

    /**
     * @notice Quote the fees for transferring tokens to L2
     * @dev OP Stack L1→L2 deposits are subsidized - no L2 gas prepayment required
     * @return quotes Empty array (no fees required beyond L1 gas)
     */
    function quoteTransferRemote(
        uint32,
        bytes32,
        uint256
    ) external pure override returns (Quote[] memory quotes) {
        // OP L1→L2 deposits are "free" - sequencer subsidizes L2 execution
        // Only L1 gas is required, which is paid by the caller
        return new Quote[](0);
    }

    /**
     * @notice Transfer tokens from L1 to L2 via the OP Standard Bridge
     * @param _destination Unused (destination is determined by the bridge)
     * @param _recipient Recipient address on L2
     * @param _amount Amount of tokens to transfer
     * @return transferId A unique identifier for the transfer
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 transferId) {
        require(_amount > 0, "Amount must be greater than 0");

        address recipient = _recipient.bytes32ToAddress();

        // Transfer tokens from caller to this contract
        IERC20(localToken).safeTransferFrom(msg.sender, address(this), _amount);

        // Bridge tokens to L2
        l1Bridge.bridgeERC20To(
            localToken,
            remoteToken,
            recipient,
            _amount,
            MIN_GAS_LIMIT,
            "" // extraData - not used
        );

        emit SentTransferRemote(_destination, _recipient, _amount);

        return bytes32(0);
    }
}
