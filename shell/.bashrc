#
# ~/.bashrc
#

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias claude='claude --dangerously-skip-permissions'
PS1='[\u@\h \W]\$ '

export ELECTRON_OZONE_PLATFORM_HINT=auto
export ELECTRON_OZONE_PLATFORM=wayland
export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.npm-global/bin:$PATH"

# OpenClaw Completion
source "/home/leandro_driguez/.openclaw/completions/openclaw.bash"

nu() { cd ~/github/nutra-expert && claude "/work $1"; }

ccswap() {
    local claude_dir="$HOME/.claude"
    local current="$claude_dir/settings.json"
    local cc="$claude_dir/settings.cc.json"
    local zc="$claude_dir/settings.zc.json"
    local marker="$claude_dir/.ccswap-profile"

    if [[ ! -f "$current" || ! -f "$cc" || ! -f "$zc" ]]; then
        echo "Missing Claude settings file in $claude_dir" >&2
        return 1
    fi

    # Active profile: from marker file, else fall back to content match.
    # Claude Code edits settings.json at runtime, so byte-compare drifts.
    local active
    active=$(cat "$marker" 2>/dev/null)
    if [[ "$active" != cc && "$active" != zc ]]; then
        if cmp -s "$current" "$cc"; then
            active=cc
        elif cmp -s "$current" "$zc"; then
            active=zc
        else
            echo "settings.json matches neither profile and no marker file exists;" >&2
            echo "run 'ccsave cc' or 'ccsave zc' to record the current settings as a profile." >&2
            return 1
        fi
    fi

    if [[ "$active" == cc ]]; then
        cp --preserve=mode "$zc" "$current"
        echo zc > "$marker"
        echo "Claude settings switched: cc -> zc"
    else
        cp --preserve=mode "$cc" "$current"
        echo cc > "$marker"
        echo "Claude settings switched: zc -> cc"
    fi
}

# Save the live settings.json as one of the profiles (updates the marker too).
ccsave() {
    if [[ "$1" != cc && "$1" != zc ]]; then
        echo "usage: ccsave cc|zc   (records settings.json as that profile)" >&2
        return 1
    fi
    cp --preserve=mode "$HOME/.claude/settings.json" "$HOME/.claude/settings.$1.json"
    echo "$1" > "$HOME/.claude/.ccswap-profile"
    echo "Saved current settings as settings.$1.json (active: $1)"
}

# Local secrets / per-machine env (gitignored, see env/.env.example)
[[ -f "$HOME/.env.local" ]] && set -a && source "$HOME/.env.local" && set +a
