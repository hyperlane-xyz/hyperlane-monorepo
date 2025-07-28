## What?

A temporary workaround to be able to call a Kas provider and logic loop without wiring through all the existing HL interface restrictions

It needs to launch a task which
1. Polls the escrow address for recent deposits 
2. Dedupes them 
3. Call relayer F() returning evidence X for validator 
4. Call validator G(X) to get bool 
5. If OK, then sign the HL message ID using the custom ISM 
6. Gather all of these over http, and send direct to hub using cosmos-rs


TODO: finish