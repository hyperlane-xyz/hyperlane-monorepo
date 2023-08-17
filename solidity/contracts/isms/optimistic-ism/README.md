# Task: Implement OptimisticISM
The OptimisticISM implements the optimistic security model (pioneered by Optics and and adopted by Synapse, Nomad, and Connext). The optimistic security model separates message verification and message delivery into two separate transactions. Specifically, verification and delivery are separated by a configurable fraud window, messages are verified first, and then after the fraud window has elapsed, they may be delivered. The fraud window exists to give time for a set of “watchers” to intervene to prevent fraudulent messages from being delivered.

## Implementation checklist:
- [x] The OptimisticISM outsources some verification logic to a different ISM referred to as “the submodule”. 
- [x] The submodule is configurable by the owner of the OptimisticISM.
- [x] The preVerify() function is responsible for message verification and verifies the message via the currently configured submodule.
- [x] This implementation allows watchers to flag submodules as compromised.
- [x] The verify() function returns true if: 
- The message has been pre-verified The submodule used to pre-verify the message has not been flagged as compromised by m-of-n watchersThe fraud window has elapsed
```function preVerifiedCheck(bytes calldata _metadata, bytes calldata _message)
        public
        returns (bool)
    {
        IInterchainSecurityModule currentModule = submodule(_message);
        if (
            relayers[msg.sender] &&
            !subModuleFlags[currentModule] &&
            _checkFraudWindow(_message)
        ) {
            return true;
        }
    }
```
### Assumptions:
- Relayers are untrusted
- Relayers will call OptimisticISM.preVerify() and OptimisticISM.verify() with whatever metadata is necessary, assuming they have access to it
- Watcher agents are observing the OptimisticISM and have access to the set of all valid messages. 
- Watchers can call a function of your choosing with arguments of your choice if they see that a fraudulent message has been submitted to the ISM

### Design goals: 
- Prioritize safety over liveness
- Simplicity
- Gas efficiency
