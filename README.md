# Forge for VS Code

Official Visual Studio Code integration for the **Forge Protocol**.

Forge for VS Code brings repository-native Forge state into the editor, providing visibility into Changes, lifecycle stages, Gates, Artifacts, Verification, Review, and diagnostics without turning the extension into a second Forge runtime.

> The repository remains the source of truth. The extension is a projection of Forge state, not its owner.

## Status

**Early Development / Experimental**

The extension is being developed independently from Forge Core and currently targets the Forge Protocol v1 architecture.

Interfaces and features may change while the integration contracts stabilize.

## What is Forge?

Forge is a repository-native engineering protocol for AI-assisted software development.

It governs engineering Changes across flows such as:

```text
Intent
  ↓
Specification
  ↓
Plan
  ↓
TDD Implementation
  ↓
Verification
  ↓
Strict Review
  ↓
Documentation
  ↓
Completion
```

Forge persists durable engineering state in the repository instead of relying on chat history or editor-specific state.

This extension makes that state accessible directly from Visual Studio Code.

## Goals

Forge for VS Code aims to provide a native development experience for Forge-enabled repositories while preserving the architectural boundaries of the Forge Protocol.

The extension should:

* detect Forge-enabled repositories;
* expose the current Change;
* visualize lifecycle state;
* show Flow and current stage;
* display Gate status;
* navigate between Forge Artifacts;
* expose validation and diagnostics;
* provide contextual Forge commands;
* eventually expose provenance and engineering evidence;
* remain compatible with Forge repositories regardless of the AI Harness being used.

## Non-Goals

Forge for VS Code is **not**:

* a replacement for the Forge Protocol;
* a second implementation of the Forge lifecycle;
* the canonical source of Change state;
* an AI provider;
* a workflow engine;
* a replacement for the Forge CLI;
* an independent authority for Gates or approvals.

The extension must not infer authoritative Forge state that belongs to the Protocol, repository, or CLI.

## Architecture

```text
                    ┌─────────────────────┐
                    │   Forge Protocol    │
                    │ canonical semantics │
                    └──────────┬──────────┘
                               │
                     repository contracts
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
        ┌────────▼────────┐         ┌────────▼─────────┐
        │    Forge CLI    │         │ Harness Adapters │
        │ validation/API │         │ AI projection    │
        └────────┬────────┘         └──────────────────┘
                 │
             CLI / JSON
                 │
        ┌────────▼─────────┐
        │ Forge for VS Code│
        │                  │
        │ Explorer         │
        │ Artifacts        │
        │ Gates            │
        │ Diagnostics      │
        │ Provenance       │
        └──────────────────┘
```

### Repository-native authority

A Forge-enabled repository contains:

```text
.forge/
```

Forge for VS Code reads and presents this state.

The extension may maintain ephemeral UI state such as expanded nodes, selected views, caches, and presentation preferences, but this state must never replace repository-native Forge evidence.

```text
Repository
    ↓
.forge/
    ↓
Forge CLI / public repository contracts
    ↓
Extension projection
    ↓
VS Code UI
```

## Integration Strategy

The extension uses two integration mechanisms.

### Repository reading

Stable, public repository-native artifacts may be read directly when doing so does not require reimplementing Forge semantics.

```text
.forge/
   ↓
Workspace Reader
   ↓
VS Code
```

### Forge CLI

Normative operations should delegate to the Forge CLI.

Examples include:

```bash
forge --version
forge validate
forge doctor
```

As machine-readable integration surfaces become available, the extension should prefer structured interfaces such as:

```bash
forge status --json
forge change list --json
forge change show CHG-XXXX --json
```

The extension must not depend on private Python APIs or internal implementation details of `forge_cli`.

## Extension Architecture

```text
src/
├── extension.ts
│
├── commands/
│   ├── openCurrentChange.ts
│   ├── openArtifact.ts
│   ├── validateRepository.ts
│   └── refresh.ts
│
├── forge/
│   ├── workspace/
│   │   ├── ForgeWorkspace.ts
│   │   └── ForgeWorkspaceDetector.ts
│   │
│   ├── cli/
│   │   └── ForgeCliClient.ts
│   │
│   ├── changes/
│   │   └── ForgeChangeReader.ts
│   │
│   └── artifacts/
│       └── ForgeArtifactReader.ts
│
├── views/
│   ├── changes/
│   ├── artifacts/
│   └── diagnostics/
│
├── statusbar/
│   └── ForgeStatusBar.ts
│
└── models/
    ├── ForgeChange.ts
    ├── ForgeArtifact.ts
    ├── ForgeGate.ts
    └── ForgeWorkspaceState.ts
```

These models represent **derived views** of Forge state.

They are not another persistence model.

## Forge Explorer

The initial Forge Explorer is expected to provide a repository overview similar to:

```text
FORGE

Changes
├── CHG-0023 · Customer Credit Limits
│   ├── Intent
│   ├── Specification
│   ├── Plan
│   ├── Verification
│   └── Review
│
└── CHG-0024 · Invoice Validation

Current Change
├── Flow: STANDARD
├── Stage: Implementation
│
└── Gates
    ├── ✓ Classification
    ├── ✓ Specification
    ├── ✓ RED
    ├── ○ Verification
    ├── ○ Review
    └── ○ Documentation

Diagnostics
└── Repository valid
```

## Commands

The initial command surface is intentionally small.

```text
Forge: Open Current Change
Forge: Open Specification
Forge: Open Plan
Forge: Open Verification
Forge: Open Review
Forge: Validate Repository
Forge: Show Diagnostics
Forge: Refresh
```

Commands that execute or govern the Forge lifecycle should only be introduced when their authority and integration boundary are explicit.

## Status Bar

Forge-enabled workspaces may expose the active Change in the VS Code status bar.

Example:

```text
$(flame) Forge · CHG-0023 · STANDARD · Implementation
```

The status bar is informational.

It does not independently determine lifecycle state.

## Protocol Compatibility

The extension and Forge Protocol are independently versioned.

Conceptually:

```text
Forge Protocol    1
Forge CLI         x.y.z
Forge VS Code     x.y.z
```

The extension should explicitly declare the Protocol versions it supports.

Example:

```json
{
  "forgeProtocol": {
    "min": 1,
    "maxExclusive": 2
  }
}
```

Unsupported Protocol versions should fail clearly rather than silently presenting potentially incorrect state.

## Development Roadmap

### Phase 0 — Extension Foundation

Create the VS Code extension project, development environment, tests, packaging, and CI.

### Phase 1 — Workspace Detection

Detect whether the current workspace is Forge-enabled.

### Phase 2 — Forge Explorer

Introduce the Forge sidebar and Change Explorer.

### Phase 3 — Artifact Navigation

Navigate directly between Intent, Specification, Plan, Verification, Review, and other repository-native Artifacts.

### Phase 4 — Change Status

Expose the current Change, Flow, lifecycle stage, and Gate state.

### Phase 5 — Validation

Integrate with:

```bash
forge validate
```

and surface validation failures through VS Code diagnostics.

### Phase 6 — Diagnostics

Expose Forge environment, Protocol compatibility, CLI availability, and repository diagnostics.

### Phase 7 — Status Bar

Display contextual Forge Change information in the editor.

### Phase 8 — Commands

Add contextual Forge commands while preserving Protocol and CLI authority boundaries.

### Phase 9 — Provenance

Navigate from engineering claims and implementation state to repository-native evidence where supported by Forge.

### Phase 10 — Capabilities

Explore editor UX for Forge capabilities such as investigation and remediation without embedding their semantics into the extension.

### Phase 11 — Harness Integration

Integrate Forge workflows with compatible AI Harness experiences while keeping Forge independent from any specific provider.

## Design Principles

### Repository is memory

Chat and editor sessions are transient.

Durable engineering evidence belongs in the repository.

### Projection, not authority

The extension visualizes Forge state. It does not manufacture it.

### Protocol first

Editor convenience must not redefine canonical Forge semantics.

### Fail closed

When authoritative state cannot be determined reliably, the extension should expose that uncertainty rather than infer success.

### Harness agnostic

The extension must remain useful regardless of whether the developer uses Claude Code, Codex, another coding Harness, or no AI Harness at all.

### Local first

Core functionality should not require a Forge-hosted service.

### Public contracts only

The extension should integrate through stable repository contracts and public CLI interfaces rather than private Forge implementation details.

## Development

Requirements:

* Node.js
* npm
* Visual Studio Code
* Forge CLI for CLI-backed integration features

Clone the repository:

```bash
git clone <forge-vscode-repository>
cd forge-vscode
npm install
```

Open the project in Visual Studio Code:

```bash
code .
```

Run the extension using the VS Code Extension Development Host.

## Testing

Tests should cover at minimum:

```text
Forge repository detection
Protocol compatibility
Change discovery
Artifact discovery
Malformed Forge state
Missing Forge CLI
Unsupported Forge version
CLI execution failures
Workspace reload
Multi-root workspaces
Path safety
Diagnostics mapping
```

Tests must not depend on the internal repository layout of `forge-protocol` beyond explicitly public Forge contracts.

Fixture repositories should represent ordinary external Forge-enabled projects.

## Security

The extension must treat repository content as untrusted input.

In particular:

* never construct unsafe shell commands from repository content;
* avoid shell interpolation when invoking Forge;
* validate repository paths;
* prevent workspace path escape;
* handle symlinks explicitly;
* never interpret repository state as human authorization unless Forge provides authoritative evidence for that decision.

## Contributing

Forge for VS Code should dogfood Forge where practical.

However, extension-specific requirements belong to this repository. Changes to the canonical Protocol should be proposed in the Forge Protocol repository rather than introduced implicitly through extension behavior.

A limitation discovered while developing the extension does not automatically justify expanding the Protocol.

First determine whether the problem belongs to:

```text
VS Code Extension
Forge CLI
Harness Adapter
Forge Protocol
CI / Integration
```

and fix it at the narrowest appropriate boundary.

## License

Licensed under the same open-source licensing strategy adopted by the Forge ecosystem.

---

**Forge for VS Code**

Repository-native engineering state, directly inside the editor.
