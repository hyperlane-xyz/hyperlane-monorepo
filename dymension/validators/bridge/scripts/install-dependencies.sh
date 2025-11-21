#!/bin/bash

set -e

echo "=========================================="
echo "Starting Installation Setup"
echo "=========================================="

# 1. Install dependencies
echo ""
echo "Step 1/3: Installing dependencies..."
echo "=========================================="
sudo apt update && sudo apt install build-essential net-tools pkg-config libssl-dev jq unzip -y

sudo apt install protobuf-compiler
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

export GO_VERSION=1.23.0
export CPU_ARCH="amd64"

wget https://go.dev/dl/go"$GO_VERSION.linux-$CPU_ARCH".tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go"$GO_VERSION.linux-$CPU_ARCH".tar.gz
echo "export PATH=\$PATH:/usr/local/go/bin" >> ~/.bashrc
source ~/.bashrc
echo "export PATH=\$PATH:\$(go env GOPATH)" >> ~/.bashrc
echo "export PATH=\$PATH:\$(go env GOPATH)/bin" >> ~/.bashrc
source ~/.bashrc

echo "Dependencies installed successfully!"

# 2. Install Rust
echo ""
echo "Step 2/3: Installing Rust..."
echo "=========================================="
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Load Rust environment
source "$HOME"/.cargo/env

# Verify installation
rustc --version
cargo --version

echo "Rust installed successfully!"

# 3. Install Foundry cast
echo ""
echo "Step 3/3: Installing Foundry..."
echo "=========================================="
curl -L https://foundry.paradigm.xyz | bash
source ${HOME}/.bashrc

foundryup

echo "Foundry installed successfully!"

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Please run: source ~/.bashrc"
echo "Or restart your terminal to load all environment variables."
