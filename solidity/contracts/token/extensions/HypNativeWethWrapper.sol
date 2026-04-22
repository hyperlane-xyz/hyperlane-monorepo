// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IWETH} from "../interfaces/IWETH.sol";
import {HypNative} from "../HypNative.sol";
import {ITokenBridge, ITokenFee, Quote} from "../../interfaces/ITokenBridge.sol";
import {Quotes} from "../libs/Quotes.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title HypNativeWethWrapper
 * @notice Entry point that pulls WETH from the sender, unwraps to native, and
 *         forwards the transfer to an existing HypNative router.
 * @dev Caller approves WETH for the full amount reported by `quoteTransferRemote`
 *      (bridged amount + IGP fee + any external fees). Since the wrapper quotes
 *      and pulls the exact native-equivalent before dispatch, no refund path is
 *      needed and `msg.value` must be zero.
 */
contract HypNativeWethWrapper is ITokenBridge {
    using SafeERC20 for IERC20;
    using Quotes for Quote[];

    IWETH private immutable weth;
    HypNative private immutable hypNative;

    constructor(IWETH _weth, HypNative _hypNative) {
        require(
            _hypNative.token() == address(0),
            "Wrapper: HypNative required"
        );
        weth = _weth;
        hypNative = _hypNative;
    }

    /**
     * @notice Returns the ERC20 token callers must approve for `transferRemote`.
     * @dev Mirrors `TokenRouter.token()`; always the wrapper's canonical WETH.
     */
    function token() external view override returns (address) {
        return address(weth);
    }

    /**
     * @inheritdoc ITokenBridge
     * @dev Pulls the full native-equivalent (bridged amount + all fees) as WETH,
     *      unwraps, and forwards to the underlying HypNative.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 messageId) {
        require(msg.value == 0, "Wrapper: msg.value must be 0");

        uint256 total = hypNative
            .quoteTransferRemote(_destination, _recipient, _amount)
            .extract(address(0));

        IERC20(address(weth)).safeTransferFrom(
            msg.sender,
            address(this),
            total
        );
        weth.withdraw(total);

        messageId = hypNative.transferRemote{value: total}(
            _destination,
            _recipient,
            _amount
        );
    }

    /**
     * @inheritdoc ITokenFee
     * @dev Mirrors the 3-quote shape of other collateral routers
     *      (index 0: gas payment, index 1: bridged amount + internal fee,
     *      index 2: external fee). Each native-denominated entry from the
     *      underlying HypNative is rewritten to WETH, since the caller pays
     *      entirely in WETH.
     */
    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = hypNative.quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );
        for (uint256 i = 0; i < quotes.length; i++) {
            if (quotes[i].token == address(0)) {
                quotes[i].token = address(weth);
            }
        }
    }

    // Receive ETH from WETH.withdraw during transferRemote.
    receive() external payable {}
}
