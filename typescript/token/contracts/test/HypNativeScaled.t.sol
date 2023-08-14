// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";

import {HypNativeScaled} from "../extensions/HypNativeScaled.sol";
import {HypERC20} from "../HypERC20.sol";
import {TypeCasts} from "@hyperlane-xyz/core/contracts/libs/TypeCasts.sol";
import {MockHyperlaneEnvironment} from "@hyperlane-xyz/core/contracts/mock/MockHyperlaneEnvironment.sol";

contract HypNativeScaledTest is Test {
    uint32 nativeDomain = 1;
    uint32 synthDomain = 2;

    uint256 synthSupply = 123456789; // 9 decimals
    uint256 scale = 10**9;

    HypNativeScaled native;
    HypERC20 synth;

    MockHyperlaneEnvironment environment;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(synthDomain, nativeDomain);

        native = new HypNativeScaled(scale);
        native.initialize(
            address(environment.mailboxes(nativeDomain)),
            address(environment.igps(nativeDomain))
        );

        synth = new HypERC20();
        synth.initialize(
            address(environment.mailboxes(synthDomain)),
            address(environment.igps(synthDomain)),
            synthSupply,
            "Zebec BSC Token",
            "ZBC"
        );

        native.enrollRemoteRouter(
            synthDomain,
            TypeCasts.addressToBytes32(address(synth))
        );
        synth.enrollRemoteRouter(
            nativeDomain,
            TypeCasts.addressToBytes32(address(native))
        );
    }

    function testTransferRemote(uint256 amount) public {
        vm.assume(amount < synthSupply && amount > 0);
        bytes32 recipient = TypeCasts.addressToBytes32(address(this));

        synth.transferRemote(nativeDomain, recipient, amount);
        environment.processNextPendingMessage();
    }
}
