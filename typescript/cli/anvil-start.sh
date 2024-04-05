#!/usr/bin/env bash

echo -e "\nYou must have 'anvil' from Foundry installed to proceed."
echo -e '\nTo install, please consult the docs at https://book.getfoundry.sh/anvil/'

read -p 'Press enter to continue running anvil...'

# Used by Anvil as export
export ANVIL_IP_ADDR='127.0.0.1'
# Passed to CLI option
export ANVIL_PORT=8545

echo -e "\nSpinning up anvil node at http://$ANVIL_IP_ADDR:$ANVIL_PORT..."

anvil -p $ANVIL_PORT
