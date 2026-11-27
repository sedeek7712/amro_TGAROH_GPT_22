# GitHub Copilot instructions

Repository-wide rules are defined in [AGENTS.md](../AGENTS.md). Read and follow that file before proposing or changing code. For domain work, also read the matching documents under docs/ai/.

Mandatory:
- Read the current code; do not treat old reports or chat history as proof of current behavior.
- Keep changes minimal and task-scoped.
- Never change accounting calculations, posted journals, real user data, database migrations, backups, restore flows, or permissions without explicit approval.
- Never delete data or write directly to main.
- Validate sensitive operations in the backend / Electron main, not only in the UI.
- Report exact tests run and results; distinguish CI build success from real Windows acceptance testing.
