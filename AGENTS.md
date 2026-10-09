# Contributor instructions

- Read relevant files before editing. Keep changes focused on the requested behavior.
- Preserve the upstream MIT attribution and the independent derivative notice.
- Never add model weights, private legal corpora, credentials, case sessions, or real case materials.
- Use synthetic data for examples and tests. Do not call a paid model during routine tests.
- Run `npm run check` after code changes, then `npm run legal:check` and relevant targeted tests. Do not run the full test suite or build unless requested.
- Explain what changed, how it was verified, and any limits. Update 改进记录.txt for LegalAgent changes.
- Stage explicit files. Do not reset, clean, stash, force-push, or overwrite others' work.
