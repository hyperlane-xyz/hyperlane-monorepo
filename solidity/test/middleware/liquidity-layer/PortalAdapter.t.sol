// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {IPortalTokenBridge} from "../../../contracts/middleware/liquidity-layer/interfaces/portal/IPortalTokenBridge.sol";
import {PortalAdapter} from "../../../contracts/middleware/liquidity-layer/adapters/PortalAdapter.sol";
import {TestTokenRecipient} from "../../../contracts/test/TestTokenRecipient.sol";
import {MockToken} from "../../../contracts/mock/MockToken.sol";
import {MockPortalBridge} from "../../../contracts/mock/MockPortalBridge.sol";
import {MockMailbox} from "../../../contracts/mock/MockMailbox.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PortalAdapterTest is Test {
    PortalAdapter originAdapter;
    PortalAdapter destinationAdapter;

    MockPortalBridge portalBridge;

    uint32 originDomain = 123;
    uint32 destinationDomain = 321;

    TestTokenRecipient recipient;
    MockToken token;

    function setUp() public {
        token = new MockToken();
        recipient = new TestTokenRecipient();

        MockMailbox originMailbox = new MockMailbox(originDomain);
        MockMailbox destinationMailbox = new MockMailbox(destinationDomain);

        originAdapter = new PortalAdapter(address(originMailbox));
        destinationAdapter = new PortalAdapter(address(destinationMailbox));

        portalBridge = new MockPortalBridge(token);

        originAdapter.initialize(
            address(this),
            address(portalBridge),
            address(this)
        );
        destinationAdapter.initialize(
            address(this),
            address(portalBridge),
            address(this)
        );

        originAdapter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(destinationAdapter))
        );
        destinationAdapter.enrollRemoteRouter(
            destinationDomain,
            TypeCasts.addressToBytes32(address(originAdapter))
        );
    }

    function testAdapter(uint256 amount) public {
        // Transfers of 0 are invalid
        vm.assume(amount > 0);
        // Calls MockPortalBridge with the right parameters
        vm.expectCall(
            address(portalBridge),
            abi.encodeCall(
                portalBridge.transferTokensWithPayload,
                (
                    address(token),
                    amount,
                    0,
                    TypeCasts.addressToBytes32(address(destinationAdapter)),
                    0,
                    abi.encode(originDomain, originAdapter.nonce() + 1)
                )
            )
        );
        token.mint(address(originAdapter), amount);
        originAdapter.sendTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount
        );
    }

    function testReceivingRevertsWithoutTransferCompletion(
        uint256 amount
    ) public {
        // Transfers of 0 are invalid
        vm.assume(amount > 0);
        token.mint(address(originAdapter), amount);
        bytes memory adapterData = originAdapter.sendTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount
        );

        vm.expectRevert("Portal Transfer has not yet been completed");

        destinationAdapter.receiveTokens(
            originDomain,
            address(recipient),
            amount,
            adapterData
        );
    }

    function testReceivingWorks(uint256 amount) public {
        // Transfers of 0 are invalid
        vm.assume(amount > 0);
        token.mint(address(originAdapter), amount);
        bytes memory adapterData = originAdapter.sendTokens(
            destinationDomain,
            TypeCasts.addressToBytes32(address(recipient)),
            address(token),
            amount
        );
        destinationAdapter.completeTransfer(
            portalBridge.mockPortalVaa(
                originDomain,
                originAdapter.nonce(),
                amount
            )
        );

        destinationAdapter.receiveTokens(
            originDomain,
            address(recipient),
            amount,
            adapterData
        );
    }
}
