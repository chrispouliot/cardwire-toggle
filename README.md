# Cardwire GPU Mode — GNOME Shell Extension

<img src="example.png" width="300" height="600" alt="Quick Settings Example Photo">

A Quick Settings toggle for [cardwire](https://github.com/OpenGamingCollective/cardwire),
the eBPF-based GPU manager. Mirrors the UX of the Power Profiles Daemon tile:
click to flip between Integrated and Hybrid, expand for the full mode list,
all without password prompts.

Tested against cardwire 0.5.0 on NixOS with GNOME 49 on an Asus G14 (2025).

## How it works

The extension talks to the `cardwired` system daemon directly over D-Bus —
no `pkexec`, no shelling out to the CLI. cardwired's D-Bus policy is open
on the system bus, so calls go through silently.

Mode changes initiated from anywhere that uses `cardwire set …` from a terminal or other tool are detected via a `Gio.FileMonitor` on the daemon's state file. UI updates are event-driven; no polling timer.
A 5-second poll fallback kicks in if the file ever becomes unreadable.
