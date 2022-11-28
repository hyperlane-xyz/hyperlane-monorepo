// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

import "../contracts/mock/MockInterchainAccountRouter.sol";

contract MockInterchainAccountTest is Test {
    OwnableMulticall ownee;
    MockInterchainAccountRouter router;
    uint32 originDomain = 1;
    uint32 remoteDomain = 2;

    function setUp() public {
        router = new MockInterchainAccountRouter(originDomain);

        address ownerICA = router.getInterchainAccount(
            originDomain,
            address(this)
        );
        // Sets the ownee owner to the ICA of the owner;
        ownee = new OwnableMulticall();
        ownee.transferOwnership(ownerICA);
    }

    function testSettingNewOwner(address newOwner) public {
        vm.assume(newOwner != address(0x0));

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: address(ownee),
            data: abi.encodeWithSelector(
                ownee.transferOwnership.selector,
                newOwner
            )
        });
        router.dispatch(remoteDomain, calls);
        router.processNextPendingCall();
        assertEq(ownee.owner(), newOwner);
    }
}
