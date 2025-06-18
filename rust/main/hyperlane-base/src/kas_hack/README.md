## What?

A temporary workaround to be able to call a Kas provider and logic loop without wiring through all the existing HL interface restrictions

It needs to launch a task which
    1. Polls the escrow address for recent deposits
       Dedupes them
       Call relayer F() returning evidence X for validator
       Call validator G(X) to get bool
       If OK, then sign the HL message ID using the custom ISM
       Gather all of these over http, and send direct to hub using cosmos-rs

__________
Somewhere else need to
    1. 
    2. 



