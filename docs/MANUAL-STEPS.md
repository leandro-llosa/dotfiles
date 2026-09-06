# Manual post-bootstrap steps

`bootstrap.sh` covers packages, configs, services, and `/etc`. The list below
covers everything it cannot do — sign-ins, key transfers, and machine-specific
state. Work through it once on a new machine.

## Secrets

- [ ] Edit `~/.env.local` and fill in real values for every key
      (`SUPABASE_ACCESS_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`,
      `ZAI_API_KEY`, …).
- [ ] Run `./bootstrap.sh --only=render-templates` to regenerate
      `~/.gitconfig`, `~/.claude/settings.zc.json`, and
      `~/.codex/config.toml` from their templates.

## Identity / keys (transfer over a secure channel — never via this repo)

- [ ] Copy SSH keys: `~/.ssh/{id_*,config,known_hosts}` from old machine
      (`scp` or USB stick), then `chmod 600 ~/.ssh/id_*`.
- [ ] Import GPG keys:
      ```bash
      # On old machine:
      gpg --export-secret-keys --armor > /tmp/gpg-secret.asc
      # On new machine:
      gpg --import /tmp/gpg-secret.asc
      shred -u /tmp/gpg-secret.asc
      ```

## CLI logins

- [ ] `gh auth login` (this also fixes `~/.gitconfig` credential helpers).
- [ ] `gcloud auth login` (and `gcloud auth application-default login` if
      using ADC).
- [ ] `tailscale up` (start Tailscale; `tailscaled.service` is already enabled).
- [ ] `supabase login` if you use the Supabase CLI.

## GUI app sign-ins

- [ ] Google Chrome: sign in to Google account, sync.
- [ ] Notion: sign in.
- [ ] Obsidian: open vault, sign in to Sync if used.

## Not covered by this repo (reinstall manually)

- [ ] CodexBar (waybar/menu-bar AI usage indicator): build/install from
      https://github.com/steipete/CodexBar — not our project, and the
      compiled binary is too large to version.
- [ ] `npm i -g ccusage` — required by `aiusage` (`~/.local/bin/aiusage`).

## Bluetooth / audio sanity check

- [ ] `bluetoothctl power on && bluetoothctl pair <device>` if you use BT
      peripherals.
- [ ] PipeWire is enabled by default; `pavucontrol` (or `wpctl status`) to
      pick the right output.

## Final reboot

- [ ] Reboot once to make sure Hyprland session via SDDM comes up clean.
