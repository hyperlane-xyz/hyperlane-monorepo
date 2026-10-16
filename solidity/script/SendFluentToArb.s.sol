// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

import "forge-std/Script.sol";

/// @dev Minimal inline views of Fluent contracts — this repo cannot take a
///      source-level dependency on `fluentlabs/solidity-contracts`. Canonical
///      declarations live in that repo:
///        - L2HypNativeGateway: contracts/gateways/L2HypNativeGateway.sol
///        - FluentBridge:       contracts/bridge/FluentBridge.sol
interface IL2HypNativeGateway {
    function sendNativeTokens(
        uint32 domain,
        bytes32 recipient,
        uint256 amount,
        uint256 hypFee
    ) external payable;

    function MIN_HYP_FEE_NATIVE() external view returns (uint256);
}

interface IFluentBridge {
    function getSentMessageFee() external view returns (uint256);
}

/// @dev Sends a test native-ETH transfer from Fluent L2 to Arbitrum Sepolia via:
///      L2HypNativeGateway → FluentBridge → L1HypNativeGateway →
///      L1FluentHypNative.transferRemote → Hyperlane → HypNative on Arb.
///
///      Recipient is encoded with `TypeCasts.addressToBytes32` so the
///      `cast --to-bytes32` right-padding pitfall is avoided.
///
///      Prerequisites for this flow to succeed end-to-end:
///        1) `L1HypNativeGateway` on Sepolia must have an ETH reserve to cover
///           drift between the user-supplied `hypFee` (estimate) and the live
///           `quoteTransferRemote` on the warp route. Top up with a plain
///           `cast send <gateway> --value <amount>` on Sepolia if needed.
///        2) `L1FluentHypNative.destinationGas[421614]` should be configured
///           (via `setDestinationGas`) so the live Hyperlane quote covers
///           actual destination handle gas on Arb Sepolia.
///        3) Stock `HypNative` on Arb Sepolia needs ETH liquidity (already
///           seeded via `deposit()` earlier).
///
///      Run:
///        forge script solidity/script/SendFluentToArb.s.sol:SendFluentToArbScript \
///          --rpc-url $(testnet) --account <name> --sender <addr> --broadcast
contract SendFluentToArbScript is Script {
    using TypeCasts for address;

    address internal constant L2_GATEWAY =
        0xe3f87C557c51b296DbC886De05744f0D52ecBb77;
    address internal constant BRIDGE =
        0x9CAcf613fC29015893728563f423fD26dCdB8Ddc;
    uint32 internal constant DESTINATION = 421614; // Arbitrum Sepolia
    uint256 internal constant SEND_AMOUNT = 0.0001 ether;
    /// @dev User-supplied Hyperlane dispatch-fee budget; floor on the L2 gateway is
    ///      `MIN_HYP_FEE_NATIVE` (0.001 ether). L1 gateway tops up from its admin
    ///      reserve if the live L1 quote exceeds this.
    uint256 internal constant HYP_FEE = 0.001 ether;
    address internal constant ARB_RECIPIENT =
        0x18FA4399b515F436E213AF5E5aD3337EbCb6E717;

    function run() public {
        bytes32 recipient32 = ARB_RECIPIENT.addressToBytes32();
        uint256 bridgeFee = IFluentBridge(BRIDGE).getSentMessageFee();
        uint256 totalValue = SEND_AMOUNT + HYP_FEE + bridgeFee;

        console.log("amount    :", SEND_AMOUNT);
        console.log("hypFee    :", HYP_FEE);
        console.log("bridgeFee :", bridgeFee);
        console.log("totalValue:", totalValue);
        console.log("recipient :", ARB_RECIPIENT);

        vm.startBroadcast();
        IL2HypNativeGateway(L2_GATEWAY).sendNativeTokens{value: totalValue}(
            DESTINATION,
            recipient32,
            SEND_AMOUNT,
            HYP_FEE
        );
        vm.stopBroadcast();
    }
}
