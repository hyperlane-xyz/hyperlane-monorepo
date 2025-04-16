{
  description = "A Nix flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    foundry = {
      url = "github:shazow/foundry.nix/monthly";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, foundry }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ foundry.overlay ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Foundry toolkit
            foundry-bin

            nodejs
            solc
          ];

          shellHook = ''
            export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
            echo "Foundry Development Environment"
            echo "--------------------------------"
            echo "Foundry version: $(forge --version)"
            echo "Cast version: $(cast --version)"
            echo "Anvil version: $(anvil --version)"
            echo "Solc version: $(solc --version)"
            echo "--------------------------------"
          '';
        };
      });
}
