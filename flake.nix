{
  description = "Cardwire GPU Toggle - GNOME Shell Quick Settings extension";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems
        (system: f { pkgs = import nixpkgs { inherit system; }; });
    in {
      packages = forAllSystems ({ pkgs }: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname  = "gnome-shell-extension-cardwire-toggle";
          version = "0.1.0";

          src = ./src;

          nativeBuildInputs = [ pkgs.glib ];

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            uuid="cardwire-toggle@chrispouliot.github.io"
            target="$out/share/gnome-shell/extensions/$uuid"
            mkdir -p "$target"
            cp -r ./* "$target/"
            if [ -d "$target/schemas" ]; then
              ${pkgs.glib.dev}/bin/glib-compile-schemas "$target/schemas"
            fi
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "GNOME Shell Quick Settings toggle for cardwire GPU mode";
            license = licenses.gpl3Plus;
            platforms = pkgs.lib.platforms.linux;
          };
        };
      });

      # Development shell
      devShells = forAllSystems ({ pkgs }: {
        default = pkgs.mkShell {
          buildInputs = [
            pkgs.gnome-shell
            pkgs.glib
            pkgs.zip
          ];
        };
      });

      # Importable Nix module
      nixosModules.default = { config, lib, pkgs, ... }: {
        config = lib.mkIf config.services.desktopManager.gnome.enable {
          environment.systemPackages = [ self.packages.${pkgs.stdenv.hostPlatform.system}.default ];
        };
      };
    };
}
