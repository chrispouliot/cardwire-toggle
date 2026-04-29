{
  description = "Cardwire GPU Mode — GNOME Shell Quick Settings extension";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems
        (system: f { pkgs = import nixpkgs { inherit system; }; });
    in {
      packages = forAllSystems ({ pkgs }: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname  = "gnome-shell-extension-cardwire";
          version = "0.1.0";

          src = ./cardwire-toggle@chrispouliot.github.com;

          nativeBuildInputs = [ pkgs.glib ];

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            uuid="cardwire-toggle@chrispouliot.github.com"
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
            platforms = platforms.linux;
          };
        };
      });

      # Importable Nix module
      nixosModules.default = { config, lib, pkgs, ... }: {
        config = lib.mkIf config.services.xserver.desktopManager.gnome.enable {
          environment.systemPackages = [ self.packages.${pkgs.system}.default ];
        };
      };
    };
}
