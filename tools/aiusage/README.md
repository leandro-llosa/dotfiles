# aiusage

Homegrown CLI that merges Claude Code, ZCode, and Codex usage into one
HTML dashboard.

```bash
aiusage              # regenerate and open the dashboard
aiusage --no-open    # regenerate only
aiusage --json       # print the merged data, don't write HTML
aiusage --out PATH   # write the HTML somewhere else
```

Requires `ccusage` on PATH (`npm i -g ccusage`).

## Layout

This is the canonical source. The `aiusage` Stow package
(`../../aiusage/.local/bin/aiusage`) is a relative symlink into this file,
so `stow aiusage` puts a working `aiusage` command on PATH, and editing
either path edits the same file.
