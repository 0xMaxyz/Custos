# scripts/

Operational scripts that must live in the repo — the Claude cloud environment clones
it and runs them to bootstrap. No build step.

## claude-cloud-environment-setup.sh

One-time environment provisioning for the Claude cloud agent (toolchain, submodules,
dependencies). Invoked by the cloud platform when the environment is first created.

## claude-cloud-session-setup.sh

Per-session setup (submodule init, `pnpm install`, offline contract build). Wired as
the `SessionStart` hook in [`.claude/settings.json`](../.claude/settings.json), so it
**must stay tracked** for cloud sessions to start cleanly.

---

Local-only dev tools (e.g. the Mantle liquidity probe) are kept out of git via the
`local.` filename prefix — see the root `.gitignore`.
