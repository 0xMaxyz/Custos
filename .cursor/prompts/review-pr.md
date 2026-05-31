# PR Review

Review the open PR on this branch against the rules in `.cursor/rules/pr-review.mdc`.

Steps:
1. Run `git diff main...HEAD` to see all changes.
2. Run the build and test commands from the review guide to confirm they pass.
3. Work through every checklist item in `pr-review.mdc` §2 (universal) and the
   relevant phase section in §3.
4. Return the structured verdict from §4 — APPROVED / CHANGES REQUESTED / BLOCKED —
   with file:line references for any findings.
