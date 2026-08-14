# pi-omo-slim

An unofficial, lightweight OMO-slim-style orchestration setup for Pi: a workflow-oriented Orchestrator plus six specialist agents (Explorer, Librarian, Oracle, Designer, Fixer, Verifier). This repo is a configuration bundle — it does not fork Pi, pi-subagents, or OMO-slim.

- TypeScript; npm. Validation: `npm run typecheck` (no build step).
- The sole install entry point is `node scripts/install.mjs` (plan/apply). Never hand-edit a generated plan or silently overwrite same-name custom Agents.
- See README.md for layout and installation; INSTALL_AGENT.md for the install procedure; agents/ holds the six Agent definitions.
