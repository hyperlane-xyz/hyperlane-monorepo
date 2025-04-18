// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {IAccessManager} from "../../contracts/interfaces/IAccessManager.sol";

contract AccessManagerForkTest is Test {
    address constant AM = 0x3D079E977d644c914a344Dcb5Ba54dB243Cc4863;
    address constant FOUNDATION_AND_DEPUTIES_MULTISIG =
        0x0000000000000000000000000000000000000001;
    address constant ATTACKER = 0x0000000000000000000000000000000000000003;
    address constant SECURITY_COUNCIL =
        0x0000000000000000000000000000000000000002;
    address constant TARGET = 0x5E532F7B610618eE73C2B462978e94CB1F7995Ce;
    bytes4 constant SELECTOR =
        bytes4(keccak256("callRemote(uint32,address,uint256,bytes)"));
    bytes constant TEST_CALLDATA =
        abi.encodeWithSelector(SELECTOR, 8453, TARGET, 0, "test payload");
    IAccessManager accessManager = IAccessManager(AM);

    function setUp() public {
        string memory rpcUrl;
        try vm.envString("RPC_URL") returns (string memory url) {
            rpcUrl = url;
        } catch {
            rpcUrl = vm.rpcUrl("http://localhost:8545");
        }
        vm.createSelectFork(rpcUrl);

        // preflight checks for test assumtions
        uint64 roleId = accessManager.getTargetFunctionRole(TARGET, SELECTOR);
        (bool hasRole, uint32 delay) = accessManager.hasRole(
            roleId,
            FOUNDATION_AND_DEPUTIES_MULTISIG
        );
        assertTrue(
            hasRole,
            "FOUNDATION_AND_DEPUTIES_MULTISIG does not have expected role"
        );
        assertGt(delay, 0, "Expected scheduling delay > 0");
    }

    function testScheduleAndExecuteCallRemote() public {
        // Impersonate FOUNDATION_AND_DEPUTIES_MULTISIG and schedule the call
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        accessManager.schedule(TARGET, TEST_CALLDATA, 0);

        // Ensure that we can't execute immediately
        bytes32 opId = accessManager.hashOperation(
            FOUNDATION_AND_DEPUTIES_MULTISIG,
            TARGET,
            TEST_CALLDATA
        );
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessManager.AccessManagerNotReady.selector,
                opId
            )
        );
        accessManager.execute(TARGET, TEST_CALLDATA);

        // Retrieve the required delay for execution
        (, uint32 delay) = IAccessManager(AM).canCall(
            FOUNDATION_AND_DEPUTIES_MULTISIG,
            TARGET,
            SELECTOR
        );
        // Fast-forward time and mine a new block
        vm.warp(block.timestamp + delay);
        vm.roll(block.number + 1);

        // Execute the scheduled call
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        accessManager.execute(TARGET, TEST_CALLDATA);
    }

    function testSecurityCouncilCanCancelScheduledOperation() public {
        // FOUNDATION_AND_DEPUTIES_MULTISIG schedules the operation.
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        accessManager.schedule(TARGET, TEST_CALLDATA, 0);

        // SECURITY_COUNCIL cancels the scheduled operation.
        vm.prank(SECURITY_COUNCIL);
        accessManager.cancel(
            FOUNDATION_AND_DEPUTIES_MULTISIG,
            TARGET,
            TEST_CALLDATA
        );

        // Execution should revert due to cancellation.
        bytes32 opId = accessManager.hashOperation(
            FOUNDATION_AND_DEPUTIES_MULTISIG,
            TARGET,
            TEST_CALLDATA
        );
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessManager.AccessManagerNotScheduled.selector,
                opId
            )
        );
        accessManager.execute(TARGET, TEST_CALLDATA);
    }

    // Here are test cases that were discovered and had to be remediated

    // TODO: this is bad
    function testBADAttackerCanRemoveSecurityCouncil() public {
        uint64 guardianRole = 4;

        // Precondition: SECURITY_COUNCIL holds the guardian role.
        (bool hasRole, ) = accessManager.hasRole(
            guardianRole,
            SECURITY_COUNCIL
        );
        assertTrue(
            hasRole,
            "Security council should initially have guardian role"
        );

        // FOUNDATION_AND_DEPUTIES_MULTISIG uses its admin role to revoke SECURITY_COUNCIL's guardian role.
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        accessManager.revokeRole(guardianRole, SECURITY_COUNCIL);

        // Postcondition: SECURITY_COUNCIL no longer holds the guardian role.
        (hasRole, ) = accessManager.hasRole(guardianRole, SECURITY_COUNCIL);
        assertFalse(
            hasRole,
            "Security council's guardian role should be revoked"
        );
    }

    // TODO: THIS IS BAD
    function testBADAttackerCanExecuteImmediately() public {
        // Retrieve the role ID for the TARGET and SELECTOR.
        uint64 roleId = accessManager.getTargetFunctionRole(TARGET, SELECTOR);

        // Use the FOUNDATION_AND_DEPUTIES_MULTISIG (admin) to reduce the execution delay to 0.
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        // Instead, have the FOUNDATION_AND_DEPUTIES_MULTISIG call grantRole with executionDelay = 0 on the role associated with the function.
        accessManager.grantRole(roleId, ATTACKER, 0);

        // Immediately execute the scheduled operation.
        vm.prank(ATTACKER);
        accessManager.execute(TARGET, TEST_CALLDATA);
    }

    // TODO: THIS IS BAD
    function testBADAttackerCanExecuteImmediatelyEvenWithRoleAdmin() public {
        // Retrieve the role ID for the TARGET and SELECTOR.
        uint64 roleId = accessManager.getTargetFunctionRole(TARGET, SELECTOR);
        // set roleAdmin to role 2
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        accessManager.setRoleAdmin(roleId, 2);

        // now bad
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = SELECTOR;
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        accessManager.setTargetFunctionRole(TARGET, selectors, 5);

        // Use the FOUNDATION_AND_DEPUTIES_MULTISIG (admin) to reduce the execution delay to 0.
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        // Instead, have the FOUNDATION_AND_DEPUTIES_MULTISIG call grantRole with executionDelay = 0 on the role associated with the function.
        accessManager.grantRole(5, ATTACKER, 0);

        // // Schedule the operation.
        // vm.prank(ATTACKER);
        // accessManager.schedule(TARGET, TEST_CALLDATA, 0);

        // Immediately execute the scheduled operation.
        vm.prank(ATTACKER);
        accessManager.execute(TARGET, TEST_CALLDATA);
    }
}
