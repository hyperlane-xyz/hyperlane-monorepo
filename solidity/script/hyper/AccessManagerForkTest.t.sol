// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {IAccessManager} from "../../contracts/interfaces/IAccessManager.sol";
import {TimelockController} from "../../contracts/upgrade/TimelockController.sol";

// TODO: execute some other scopes
contract AccessManagerForkTest is Test {
    address constant AM = 0x3D079E977d644c914a344Dcb5Ba54dB243Cc4863;
    address constant FOUNDATION_AND_DEPUTIES_MULTISIG =
        0xec2EdC01a2Fbade68dBcc80947F43a5B408cC3A0;
    address constant ATTACKER = 0x0000000000000000000000000000000000000003;
    address constant SECURITY_COUNCIL =
        0xE8055e2763DcbA5a88B1278514312d7C04f0473D;
    address constant TARGET = 0x5E532F7B610618eE73C2B462978e94CB1F7995Ce;
    address payable TIMELOCK_ADMIN =
        payable(0xfA842f02439Af6d91d7D44525956F9E5e00e339f);
    bytes4 constant SELECTOR =
        bytes4(keccak256("callRemote(uint32,address,uint256,bytes)"));
    bytes constant TEST_CALLDATA =
        abi.encodeWithSelector(SELECTOR, 8453, TARGET, 0, "test payload");
    IAccessManager accessManager = IAccessManager(AM);
    uint256 constant TIMELOCK_DELAY = 14 days;
    TimelockController timelock = TimelockController(TIMELOCK_ADMIN);

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

    function testTimelockCanGrantRoleMembershipViaProposal(
        uint32 testRole,
        address testAccount,
        uint32 executionDelay
    ) public {
        // Precondition: testAccount should not have the role
        (bool hasRole, ) = accessManager.hasRole(testRole, testAccount);
        assertFalse(
            hasRole,
            "Precondition: testAccount should not have the role"
        );

        // Create proposal data for grantRole(testRole, testAccount, executionDelay)
        bytes memory proposalData = abi.encodeWithSelector(
            IAccessManager.grantRole.selector,
            testRole,
            testAccount,
            executionDelay
        );

        executeAdminActionViaTimelock(proposalData);

        // // Verify that testAccount now has testRole with the specified executionDelay
        (bool grantedHasRole, uint32 grantedDelay) = accessManager.hasRole(
            testRole,
            testAccount
        );
        assertTrue(
            grantedHasRole,
            "testAccount should have testRole after proposal execution"
        );
        assertEq(executionDelay, grantedDelay, "executionDelay should match");
    }

    function executeAdminActionViaTimelock(bytes memory callData) internal {
        // Schedule the proposal via timelock
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        bytes32 salt = keccak256("testTimelockGrantRole");
        timelock.schedule(
            address(accessManager),
            0,
            callData,
            bytes32(0),
            salt,
            TIMELOCK_DELAY
        );

        // Expect revert on the timelock
        vm.expectRevert("TimelockController: operation is not ready");
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        timelock.execute(address(accessManager), 0, callData, bytes32(0), salt);

        // Fast forward time past the timelock delay
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);
        vm.roll(block.number + 1);

        // Execute the proposal via timelock
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        timelock.execute(address(accessManager), 0, callData, bytes32(0), salt);
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
        // vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        // accessManager.revokeRole(guardianRole, SECURITY_COUNCIL);

        // Revoke via Timelock
        bytes memory proposalData = abi.encodeWithSelector(
            IAccessManager.revokeRole.selector,
            guardianRole,
            SECURITY_COUNCIL
        );
        executeAdminActionViaTimelock(proposalData);

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

        bytes memory proposalData = abi.encodeWithSelector(
            IAccessManager.grantRole.selector,
            roleId,
            ATTACKER,
            0
        );
        executeAdminActionViaTimelock(proposalData);

        // Immediately execute the scheduled operation.
        vm.prank(ATTACKER);
        accessManager.execute(TARGET, TEST_CALLDATA);
    }

    // TODO: THIS IS BAD
    function testBADAttackerCanExecuteImmediatelyEvenWithRoleAdmin() public {
        // Retrieve the role ID for the TARGET and SELECTOR.
        uint64 roleId = accessManager.getTargetFunctionRole(TARGET, SELECTOR);
        // set roleAdmin to role 2
        bytes memory proposalData = abi.encodeWithSelector(
            IAccessManager.setRoleAdmin.selector,
            roleId,
            2
        );
        executeAdminActionViaTimelock(proposalData);

        // now bad
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = SELECTOR;
        bytes memory setData = abi.encodeWithSelector(
            IAccessManager.setTargetFunctionRole.selector,
            TARGET,
            selectors,
            5
        );
        executeAdminActionViaTimelock(setData);

        // Use the admin to reduce the execution delay to 0.
        bytes memory grantRoleData = abi.encodeWithSelector(
            IAccessManager.grantRole.selector,
            5,
            ATTACKER,
            0
        );
        executeAdminActionViaTimelock(grantRoleData);

        // // Schedule the operation.
        // vm.prank(ATTACKER);
        // accessManager.schedule(TARGET, TEST_CALLDATA, 0);

        // Immediately execute the scheduled operation.
        vm.prank(ATTACKER);
        accessManager.execute(TARGET, TEST_CALLDATA);
    }
}
