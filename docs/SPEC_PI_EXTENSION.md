# Specification B — pi-jev as a Pi extension/package

**Status:** recommended first implementation track.

## 1. Goal

Implement the TypeSafe-first ideas as an installable Pi package before building a standalone agent.

Pi's current extension system can register tools and commands, subscribe to lifecycle events, block or modify tool calls/results, customize compaction, persist state, integrate external systems, and provide custom UI. Pi packages can bundle extensions, skills, prompts, themes, and dependencies and install from npm or Git.

That makes an extension/package viable for a substantial first version.

## 2. Hypothesis

Without replacing Pi's normal coding UX we can validate:
- Jev-assisted permission gates;
- capability/tool routing;
- explicit pi-jev state;
- hierarchical history;
- task-specific context injection/filtering;
- Jev-aware compaction;
- conditional instructions;
- evaluation/telemetry;
- read-only background work.

The critical unknown is whether the extension API gives enough control over **the exact context and capability set presented to each model call**.

## 3. Packaging

Proposed structure:

```
package.json
extensions/
  jev.ts
src/
  jev/
  context/
  capabilities/
  policy/
  telemetry/
  workers/
skills/
  pi-jev/
    SKILL.md
docs/
```

The package declares Pi resources in `package.json` and uses the `pi-package` keyword. Pi core packages are peer dependencies; Jev/TypeSafe clients are runtime dependencies.

Target install path:

```
pi install git:github.com/0x7067/pi-jev
```

and npm later if published.

## 4. Extension responsibilities

### Lifecycle interception

Use Pi events to observe task changes, update explicit state, inspect/block effectful tool calls, capture tool outputs as SourceChunks, influence context/compaction where supported, and attach telemetry.

### Custom tools and commands

Useful operator surfaces may include:
- `/jev-status`;
- `/jev-context`;
- `/jev-decisions`;
- `/jev-eval`.

Do not expose Jev as a generic “ask classifier anything” tool. Invoke typed questions internally at controlled decision points.

### Persistence

Use Pi session/extension persistence for durable references and a project-local pi-jev store for larger indexed state if needed.

Persist hierarchy, SourceChunk references, decision records, task metadata, derived summaries, and source snapshots.

## 5. Permission gate

This is the cleanest first feature because Pi extensions can intercept tool calls and block them.

For effectful tools:
1. normalize the action;
2. inspect relevant command/script/file contents;
3. apply deterministic hard policy;
4. run bounded Jev questions;
5. allow, block, or ask the user;
6. record the decision.

Jev unavailability never means permission.

## 6. Capability routing

Test progressively stronger strategies.

### Phase 1
Use Jev to choose among a bounded set of pi-jev meta-capabilities.

### Phase 2
Maintain a larger registry and expose only a selected subset if Pi permits tool-set changes at the required boundary.

### Phase 3 fallback
If dynamic tool visibility cannot be controlled cleanly, expose one stable discovery/dispatch surface. It resolves high-level intent into a capability, then requests only the selected schema's arguments.

This still tests lazy discovery but is less pure than direct per-turn tool-set control and must be measured separately.

## 7. Context and hierarchical history

Maintain pi-jev SourceChunks and ContextNodes independently of Pi's compacted transcript.

At meaningful task boundaries:
1. navigate relevant branches with Jev;
2. retrieve candidate chunks;
3. choose representation levels;
4. construct a supplemental ContextView;
5. inject or replace context using the strongest supported hook.

Pi's custom-compaction hooks can test query-aware compaction, but **compaction is not the authoritative store**. Raw/source references remain recoverable.

## 8. Critical extension-boundary test

Before advanced features, prove exactly what Pi lets the extension control at model-call time.

The package passes if, without patching Pi, it can:
- determine or materially constrain generator context;
- avoid permanent context pollution from irrelevant extension state;
- intercept all relevant effectful tools;
- persist/reconstruct its own state;
- select capabilities lazily enough to test the thesis.

If context ownership remains fundamentally inside Pi and cannot be overridden without brittle tricks, stop expanding the extension and move the shared core into the standalone architecture.

That is a design result, not a failed prototype.

## 9. Routing and subagents

Start conservatively.

Pi already supplies multi-provider/model infrastructure. The extension can use it for auxiliary Jev-informed tasks and workers where supported.

Do not claim full dynamic routing until the extension can account for current context reuse, rebuild cost, target-model context, worker reintegration, and provider security restrictions.

If the main-session model cannot be switched together with a task-specific ContextView atomically, leave full routing to the standalone track.

## 10. Background processing

A Pi extension is well suited to read-only subscribers because it can observe project/session events and maintain external state.

Initial candidate: cross-model review or repository explanation after meaningful source changes.

Requirements:
- read-only against source tree;
- bounded budget;
- source snapshot attached;
- stale-output detection;
- no silent foreground blocking.

## 11. Shared core

Do not put business logic directly in event handlers.

Framework-agnostic modules:
- Jev client/question catalog;
- SourceChunk/ContextNode models;
- hierarchy traversal;
- capability registry;
- permission semantics;
- routing cost model;
- decision telemetry;
- evaluation fixtures.

Pi adapter:
- event wiring;
- UI;
- session persistence adapter;
- tool interception;
- context injection;
- provider/model integration.

## 12. Delivery plan

### E0 — extension capability probe
Build a tiny diagnostic extension proving event coverage, context/compaction hooks, dynamic tool behavior, persistence, and model-call visibility.

### E1 — Jev permission gate
Intercept bash/write/edit and evaluate concrete actions.

### E2 — explicit state + history
Capture SourceChunks and build the hierarchical index.

### E3 — context selection
Use Jev tree traversal to build task-specific views and compare against normal Pi.

### E4 — capability discovery
Add lazy capability routing and measure prompt/catalog overhead.

### E5 — background subscriber
Add one read-only subscriber using shared discovered state.

### E6 — routing experiment
Only if extension hooks support clean context/model switching.

## 13. Evaluation

Run the same coding tasks under:
1. normal Pi;
2. Pi + permission-only pi-jev;
3. Pi + flat context filtering;
4. Pi + hierarchical context selection;
5. Pi + lazy capability discovery;
6. standalone pi-jev when available.

Measure task success, wall time, total spend, Jev calls/input, generator input/cache/output, relevant-evidence recall, tool-selection correctness, permission errors, and context size.

## 14. Graduation criteria to standalone

Move the core loop to Specification A if any of these are structurally blocked:
- exact per-turn ContextView ownership;
- lazy capability/schema exposure;
- task-specific model switching with known context;
- worker-specific contexts;
- reliable interception of all effectful paths;
- explicit-state reconstruction independent of Pi transcript/compaction.

## 15. Recommendation

**Build this track first.**

Pi's documented extension/package surface is unusually close to the required experiment: custom tools, lifecycle interception, state persistence, custom compaction, external integrations, and installable Git/npm packages.

The extension approach minimizes infrastructure while giving us a hard, falsifiable boundary test. If it works, pi-jev can remain a lightweight Pi package. If it does not, the shared core moves to the standalone runtime with the failed boundary precisely identified.
