alias claude='claude --dangerously-skip-permissions'

# Local secrets / per-machine env (gitignored, see env/.env.example)
[[ -f "$HOME/.env.local" ]] && set -a && source "$HOME/.env.local" && set +a
