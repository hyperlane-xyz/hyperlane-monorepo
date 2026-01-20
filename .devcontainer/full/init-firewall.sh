#!/bin/bash
# Hyperlane Devcontainer Firewall Script
# Adapted from Claude Code reference implementation
# https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh
#
# Supports two modes:
#   - strict (default): Only whitelisted domains, no RPC access
#   - relaxed: Adds common RPC providers for integration testing
#
# Set mode via environment variable: DEVCONTAINER_FIREWALL_MODE=relaxed

set -euo pipefail
IFS=$'\n\t'

FIREWALL_MODE="${DEVCONTAINER_FIREWALL_MODE:-strict}"
echo "Firewall mode: $FIREWALL_MODE"

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush existing rules and delete existing ipsets
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
	echo "Restoring Docker DNS rules..."
	iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
	iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
	echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
	echo "No Docker DNS rules to restore"
fi

# First allow DNS and localhost before any restrictions
# Allow outbound DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
# Allow inbound DNS responses
iptables -A INPUT -p udp --sport 53 -j ACCEPT
# Allow outbound SSH
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
# Allow inbound SSH responses
iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Create ipset with CIDR support
ipset create allowed-domains hash:net

# Fetch GitHub meta information and aggregate + add their IP ranges
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -s https://api.github.com/meta)
if [ -z "$gh_ranges" ]; then
	echo "ERROR: Failed to fetch GitHub IP ranges"
	exit 1
fi

if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
	echo "ERROR: GitHub API response missing required fields"
	exit 1
fi

echo "Processing GitHub IPs..."
while read -r cidr; do
	if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
		echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
		exit 1
	fi
	echo "Adding GitHub range $cidr"
	ipset add allowed-domains "$cidr"
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

# Core domains (always allowed)
CORE_DOMAINS=(
	# npm
	"registry.npmjs.org"
	# Anthropic/Claude
	"api.anthropic.com"
	"statsig.anthropic.com"
	# Telemetry
	"sentry.io"
	"statsig.com"
	# VS Code
	"marketplace.visualstudio.com"
	"vscode.blob.core.windows.net"
	"update.code.visualstudio.com"
	# Rust/Cargo
	"crates.io"
	"static.crates.io"
	"index.crates.io"
	# Foundry
	"raw.githubusercontent.com"
	"foundry-releases.s3.amazonaws.com"
	# Hyperlane
	"hyperlane.xyz"
	"api.hyperlane.xyz"
	"explorer.hyperlane.xyz"
	"registry.hyperlane.xyz"
	# Google Cloud
	"storage.googleapis.com"
	"oauth2.googleapis.com"
	"secretmanager.googleapis.com"
	"cloudresourcemanager.googleapis.com"
	# Notion
	"api.notion.com"
	# Linear
	"api.linear.app"
	# GitHub CLI auth
	"github.com"
)

# RPC provider domains (only in relaxed mode)
RPC_DOMAINS=(
	# Alchemy
	"eth-mainnet.alchemyapi.io"
	"arb-mainnet.g.alchemy.com"
	"opt-mainnet.g.alchemy.com"
	"polygon-mainnet.g.alchemy.com"
	# QuickNode (uses dynamic subdomains, resolve common ones)
	# P2Pify
	# Infura
	"mainnet.infura.io"
	"arbitrum-mainnet.infura.io"
	"optimism-mainnet.infura.io"
	"polygon-mainnet.infura.io"
	# Ankr
	"rpc.ankr.com"
	# LlamaRPC
	"eth.llamarpc.com"
	# DRPC
	"eth.drpc.org"
)

# Resolve and add core domains
for domain in "${CORE_DOMAINS[@]}"; do
	echo "Resolving $domain..."
	ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
	if [ -z "$ips" ]; then
		echo "WARNING: Failed to resolve $domain, skipping..."
		continue
	fi

	while read -r ip; do
		if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
			echo "WARNING: Invalid IP from DNS for $domain: $ip, skipping..."
			continue
		fi
		echo "Adding $ip for $domain"
		ipset add allowed-domains "$ip" 2>/dev/null || true
	done < <(echo "$ips")
done

# Add RPC domains if in relaxed mode
if [ "$FIREWALL_MODE" = "relaxed" ]; then
	echo "Relaxed mode: Adding RPC provider domains..."
	for domain in "${RPC_DOMAINS[@]}"; do
		echo "Resolving RPC domain $domain..."
		ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
		if [ -z "$ips" ]; then
			echo "WARNING: Failed to resolve $domain, skipping..."
			continue
		fi

		while read -r ip; do
			if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
				echo "WARNING: Invalid IP from DNS for $domain: $ip, skipping..."
				continue
			fi
			echo "Adding $ip for $domain"
			ipset add allowed-domains "$ip" 2>/dev/null || true
		done < <(echo "$ips")
	done

	# Add broader CIDR ranges for dynamic RPC subdomains
	# QuickNode uses *.quiknode.pro with dynamic subdomains
	# These are approximate ranges - may need adjustment
	echo "Adding broad RPC provider ranges..."
	# Note: In production, you may want to look up actual provider IP ranges
fi

# Get host IP from default route
HOST_IP=$(ip route | grep default | cut -d" " -f3)
if [ -z "$HOST_IP" ]; then
	echo "ERROR: Failed to detect host IP"
	exit 1
fi

HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
echo "Host network detected as: $HOST_NETWORK"

# Set up remaining iptables rules
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# Set default policies to DROP first
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# First allow established connections for already approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Then allow only specific outbound traffic to allowed domains
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "Firewall configuration complete"
echo "Verifying firewall rules..."

# Verify blocked domain
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
	echo "ERROR: Firewall verification failed - was able to reach https://example.com"
	exit 1
else
	echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

# Verify GitHub API access
if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
	echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
	exit 1
else
	echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi

echo "Firewall setup complete (mode: $FIREWALL_MODE)"
