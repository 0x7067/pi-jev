# Product Vision — pi-jev

## Thesis

Build a coding agent where Jev/TypeSafe is part of the control plane rather than a safety classifier bolted onto a conventional agent.

Generative models still reason, write code, construct tool arguments, and explain results. Jev makes many narrow, cheap semantic judgments that decide what context matters, which capabilities should be exposed, whether an action should proceed, and which model or worker should handle a task.

The product hypothesis is that explicit state plus cheap semantic judgment can make coding agents more capable and economical without forcing every future turn through one ever-growing context.

## Why

Current coding agents are structurally simple, but several conventions are consequences of treating a long model context as the agent's state: model routing can become uneconomical when switching requires reprocessing large contexts; large tool catalogs consume context even when most tools are irrelevant; compaction assumes future work needs one shared compressed history; subagents need awkward context handoffs; restarting can lose useful state; and batteries can permanently increase prompt/tool overhead.

pi-jev treats those as runtime-design problems.

## Product principles

1. **Jev-first, not Jev-added.** Jev participates in permissions, capability discovery, context selection, and routing.
2. **Context is constructed, not accumulated.** Preserve recoverable source state and build a task-specific ContextView for each meaningful step.
3. **Cache reuse is an optimization, not an architecture.** Reuse KV state when it wins; rebuild when a narrower or different context is better.
4. **Capabilities are discoverable and lazy.** Load full schemas and instructions only when useful.
5. **State is explicit.** Tasks, evidence, revisions, constraints, worker outputs, and decisions are durable objects.
6. **History is hierarchical.** Navigate task/history trees instead of repeatedly classifying every old message.
7. **Workers receive views, not transcripts.**
8. **Read-only background work should share discovery.**
9. **Semantic judgment does not replace deterministic policy.**
10. **Measure end-to-end outcomes.**

## Why Pi

Pi is the chosen substrate because it is intentionally a small coding harness and exposes both an embeddable SDK and a first-class extension/package system. We want its model/provider access, tools, sessions, TUI, authentication, and ordinary coding loop while keeping ownership of the experimental control plane.

The non-negotiable boundary is: **Pi must not silently own context construction for the TypeSafe-native path.**

## Two implementation tracks

### Track A — standalone Pi-based runtime

Embed Pi's SDK/core and make pi-jev the application. pi-jev owns loop boundaries, ContextView construction, capability registry, routing, policy, worker runtime, and persistence. Pi supplies low-level infrastructure.

This has the highest fidelity to the full TypeSafe-first thesis.

### Track B — Pi extension/package

Ship pi-jev as an installable Pi package containing TypeScript extensions plus supporting modules. Intercept lifecycle/tool/context events, register Jev-aware tools and commands, customize compaction/context behavior where the API permits, and persist pi-jev state alongside sessions.

This is the fastest path to a usable experiment and tests whether Pi's extension boundary is sufficient.

## Product strategy

Start with the extension/package because it can validate the highest-value hypotheses with far less infrastructure. Keep the standalone spec alive in parallel.

If the extension API prevents pi-jev from controlling context construction, lazy capability exposure, routing, or worker contexts without fighting Pi's defaults, that is the explicit graduation criterion for moving the core experiment to the standalone runtime.

The extension is not a throwaway prototype. Framework-agnostic modules must be reusable by the standalone design.

## Initial proof

A successful first proof demonstrates:
1. Jev-assisted permission judgment over the actual proposed action.
2. Jev capability selection without preloading a large tool catalog.
3. Hierarchical retrieval of relevant prior state.
4. Construction of a smaller task-specific context preserving required constraints.
5. Measured comparison against normal Pi on the same task.
6. Recovery/fallback when Jev is uncertain or unavailable.

## Long-term outcome

pi-jev should make hundreds of optional capabilities, deep persistent project history, cheap background analyses, and model/worker routing practical without forcing all of that state into every expensive generation.

The defining question is:

> What does a coding agent look like when cheap typed semantic judgment is a native runtime primitive?
