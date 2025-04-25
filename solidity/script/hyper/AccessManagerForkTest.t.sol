// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {IAccessManager} from "../../contracts/interfaces/IAccessManager.sol";
import {TimelockController} from "../../contracts/upgrade/TimelockController.sol";
import {HyperToken} from "../../contracts/token/extensions/HyperToken.sol";

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
    uint256 constant SEVEN_DAYS = 7 days;
    uint256 constant THIRTY_DAYS = 30 days;
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

    function testBaseConfiguration() public view {
        // Check that the FOUNDATION_AND_DEPUTIES_MULTISIG has the proposer role on the timelock
        assertTrue(
            timelock.hasRole(
                keccak256("PROPOSER_ROLE"),
                FOUNDATION_AND_DEPUTIES_MULTISIG
            ),
            "FOUNDATION_AND_DEPUTIES_MULTISIG does not have proposer role"
        );
        // Check that the SECURITY_COUNCIL has the canceller role on the timelock
        assertTrue(
            timelock.hasRole(keccak256("CANCELLER_ROLE"), SECURITY_COUNCIL),
            "SECURITY_COUNCIL does not have canceller role"
        );
        // Check that 0x0 has the executor role on the timelock
        assertTrue(
            timelock.hasRole(keccak256("EXECUTOR_ROLE"), address(0)),
            "0x0 does not have executor role"
        );

        // Check that the deployer key 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba no longer has any role on the timelock
        assertFalse(
            timelock.hasRole(
                keccak256("PROPOSER_ROLE"),
                0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba
            ),
            "Deployer key should not have proposer role"
        );
        assertFalse(
            timelock.hasRole(
                keccak256("CANCELLER_ROLE"),
                0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba
            ),
            "Deployer key should not have canceller role"
        );
        assertFalse(
            timelock.hasRole(
                keccak256("EXECUTOR_ROLE"),
                0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba
            ),
            "Deployer key should not have executor role"
        );
        assertFalse(
            timelock.hasRole(
                keccak256("TIMELOCK_ADMIN_ROLE"),
                0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba
            ),
            "Deployer key should not have executor role"
        );

        // Check that the access manager has the timelock as its admin
        (bool amHasRole, ) = accessManager.hasRole(0, address(timelock));
        assertTrue(amHasRole, "AccessManager admin should be the timelock");
        // Check that the original deployer does not have admin still
        (bool deployerHasRole, ) = accessManager.hasRole(
            0,
            0x79fa1F70fBBA4Dd07510B21b32525b602FaDf31c
        );
        assertFalse(
            deployerHasRole,
            "Deployer key should not have AccessManager admin role"
        );
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

        // Fast-forward time and mine a new block
        vm.warp(block.timestamp + SEVEN_DAYS);
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

        // Execute the proposal via timelock (anyone can)
        vm.prank(address(0x1));
        timelock.execute(address(accessManager), 0, callData, bytes32(0), salt);
    }

    function roleIdFromLabel(
        string memory label
    ) internal pure returns (uint64 roleId) {
        bytes32 fullHash = keccak256(abi.encodePacked(label));
        assembly {
            roleId := shr(192, fullHash)
        }
    }

    // Here are test cases that were discovered and had to be remediated

    // TODO: this is bad
    function testBADAttackerCanRemoveSecurityCouncil() public {
        uint64 guardianRole = roleIdFromLabel("Security Council");

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

    // Additional tests
    function testMintHyperTokenAfterThirtyDayDelay() public {
        address hyperToken = 0x93A2Db22B7c736B341C32Ff666307F4a9ED910F5; // Replace with actual address if needed
        address recipient = address(0xBEEF);
        uint256 amount = 1e18;
        bytes32 MINTER_ROLE = keccak256("MINTER_ROLE");

        // Grant MINTER_ROLE to this test contract
        bytes memory grantRoleCallData = abi.encodeWithSignature(
            "grantRole(bytes32,address)",
            MINTER_ROLE,
            address(this)
        );

        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        accessManager.schedule(hyperToken, grantRoleCallData, 0);

        // Fast-forward 30 days
        vm.warp(block.timestamp + THIRTY_DAYS);
        vm.roll(block.number + 1);

        // Execute role grant
        vm.prank(FOUNDATION_AND_DEPUTIES_MULTISIG);
        accessManager.execute(hyperToken, grantRoleCallData);

        // Mint tokens directly from the test contract
        HyperToken(hyperToken).mint(recipient, amount);
    }
}
