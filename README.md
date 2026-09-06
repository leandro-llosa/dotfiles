# dotfiles

My Arch Linux + Hyprland setup, packaged as GNU Stow modules with a one-shot
bootstrap script.

## Quickstart on a fresh Arch install

```bash
# 1. Get the repo
git clone https://github.com/<your-user>/dotfiles.git ~/github/dotfiles
cd ~/github/dotfiles

# 2. Run the bootstrap (installs packages, links configs, enables services)
./bootstrap.sh

# 3. Fill in real values for any secrets, then reboot or re-login
$EDITOR ~/.env.local
```

That's it. To preview without changing anything: `./bootstrap.sh --dry-run`.

## What this repo contains

### Stow packages (top-level dirs that mirror `$HOME`)

| Package      | Destination                                | Purpose                              |
|--------------|--------------------------------------------|--------------------------------------|
| `shell`      | `~/.bashrc`, `~/.zshrc`, `~/.npmrc`, …     | Shell rcfiles, sourced by every term |
| `git`        | `~/.gitconfig`, `~/.config/git/ignore`     | Git identity (rendered from tmpl)    |
| `hyprland`   | `~/.config/hypr/`                          | Wayland compositor config            |
| `waybar`     | `~/.config/waybar/`                        | Top bar                              |
| `alacritty`  | `~/.config/alacritty/`                     | Terminal                             |
| `ghostty`    | `~/.config/ghostty/`                       | Terminal (alt)                       |
| `rofi`       | `~/.config/rofi/`                          | Application launcher themes          |
| `fontconfig` | `~/.config/fontconfig/`                    | Font rendering rules                 |
| `desktop`    | `~/.config/{gtk-3.0,yay,dconf,…}`          | Misc desktop / freedesktop bits      |
| `fonts`      | `~/.local/share/fonts/`                    | Locally installed fonts              |
| `gh`         | `~/.config/gh/config.yml`                  | GitHub CLI config (no auth token)    |
| `htop`       | `~/.config/htop/`                          | Process viewer                       |
| `uv`         | `~/.config/uv/`                            | Python packaging tool                |
| `claude-code`| `~/.claude/{settings*.json,skills/}`       | Claude Code settings + skills        |
| `codex`      | `~/.codex/{config.toml,rules/}`            | Codex CLI config (secrets templated) |
| `aiusage`    | `~/.local/bin/aiusage`                     | Homegrown AI usage dashboard tool    |

Stowing is reversible: `cd ~/github/dotfiles && stow -D <package>` removes the
symlinks.

### Meta directories (NOT Stow packages)

| Dir         | Purpose                                                        |
|-------------|----------------------------------------------------------------|
| `bootstrap.sh` | One-shot installer, orchestrates phases                     |
| `Makefile`  | `make install`, `make stow`, `make export`, `make uninstall`   |
| `packages/` | `pacman.txt`, `aur.txt`, `flatpak.txt`                         |
| `system/`   | `etc/` files + `services-system.txt`, `services-user.txt`      |
| `scripts/`  | Bootstrap helpers (one script per phase)                       |
| `env/`      | `.env.example` template for secrets                            |
| `docs/`     | Architecture, maintenance, manual post-install steps           |
| `legacy/`   | Old NixOS / XMonad / Polybar configs, archived                 |

## Common commands

```bash
make install          # full bootstrap (alias for ./bootstrap.sh --yes)
make stow             # only re-link Stow packages
make pkgs             # only re-install packages
make export           # regenerate packages/*.txt + system/services-*.txt
make uninstall        # stow -D every package (does not remove pacman pkgs)
make lint             # shellcheck

./bootstrap.sh --dry-run            # show actions, change nothing
./bootstrap.sh --only=stow          # run a single phase
./bootstrap.sh --skip-pkgs          # skip package install
```

## How to add a new config

1. Find what app writes config in `~/.config/<app>` (or as `~/.<app>rc`).
2. Create a Stow package mirroring the destination:
   ```bash
   mkdir -p <app>/.config/<app>
   cp -r ~/.config/<app>/. <app>/.config/<app>/
   ```
3. Stow it: `stow -t ~ <app>`
4. Commit the new package.

## How to add a new package

```bash
sudo pacman -S <pkg>            # or yay -S <pkg> for AUR
make export                     # regenerates packages/*.txt
git diff packages/              # check the change
git commit -am "pkgs: add <pkg>"
```

## Secrets

No secrets in tracked files. `~/.env.local` (gitignored) holds tokens and is
sourced by `.bashrc` / `.zshrc`. Template: `env/.env.example`.

## More

- `docs/ARCHITECTURE.md` — bootstrap phases, file destinations, change cycle.
- `docs/MAINTENANCE.md`  — recipes for common edits.
- `docs/MANUAL-STEPS.md` — post-bootstrap checklist (SSH/GPG keys, browser logins).
- `CLAUDE.md`            — orientation for AI coding agents.

## License

See `LICENSE`.
