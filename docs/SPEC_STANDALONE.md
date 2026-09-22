# Specification A — Standalone Pi-based TypeSafe-first agent

**Status:** proposed reference architecture.

## 1. Goal

Build pi-jev as its own coding-agent application while reusing Pi as a low-level substrate. The application owns the TypeSafe-native control plane: context construction, capability exposure, permissions, routing, worker contexts, explicit state, and evaluation.

## 2. Pi integration boundary

Reuse Pi for provider/model abstraction and authentication, basic agent execution primitives, built-in coding tools where appropriate, session/event primitives, terminal UI, streaming, and usage accounting.

pi-jev owns SourceChunk and ContextNode persistence, hierarchical history, ContextView construction, Jev Noul/Choice/Score calls, capability registry and lazy schema loading, policy decisions, model/worker routing, background subscribers, full-path cost accounting, and evaluation traces.

Pi's default compaction or append-only conversation state must not become the authoritative state.

## 3. Core runtime objects

**SourceChunk:** recoverable evidence with kind, raw source or durable reference, provenance, repository/source revision, task association, sensitivity/destination policy, relationships, and derived representations.

**ContextNode:** hierarchical index node with parent/children, task/topic labels, compact description, SourceChunk references, source revision, and cross-links.

**ContextView:** exact payload for one expensive model call: objective, applicable constraints, selected evidence/representation level, visible capabilities/schemas, model/provider, budget, and provenance.

**AgentTask:** objective, constraints, source snapshot, permitted destinations, capability/write scope, budget, and parent/worker relationships.

**DecisionRecord:** decision kind, Jev model/question version, input references, answer/score/choice, uncertainty/failure, resulting action, latency, and usage.

## 4. Execution cycle

1. Record objective and update task/history nodes.
2. Apply deterministic destination/security restrictions before sending content to any model, including Jev.
3. Navigate hierarchical history with narrow Jev judgments.
4. Discover relevant capabilities using compact descriptions.
5. Build candidate ContextViews.
6. Compare reuse/rebuild/model/worker plans using measured costs plus semantic suitability.
7. Run the chosen generative model.
8. Validate proposed tool arguments.
9. Run Jev-assisted permission judgments over the concrete action and inspected contents.
10. Enforce deterministic policy and execute only when authorized.
11. Store results as versioned evidence.
12. Trigger eligible background subscribers.
13. Repeat until complete, blocked, clarification is needed, or budget is reached.

## 5. Context engine

The authoritative state is not the current LLM transcript. Source material remains recoverable independently.

Initial representation levels are omit/full; later add short/long/full/omit. Jev judges relevance and sufficiency; deterministic code preserves mandatory active constraints. Summaries never replace raw evidence.

### Hierarchical search

Maintain a task/topic tree incrementally. Jev selects promising branches, descendants, then leaf evidence.

Requirements:
- multiple branches may be selected;
- uncertain search can widen;
- relevant old sessions remain addressable;
- worker evidence enters the same hierarchy;
- Jev receives enough text to decide, not opaque IDs;
- flat scan remains an evaluation baseline.

## 6. Capability engine

Capabilities have a compact discovery description, complete schema, optional guidance/examples, and permission/security metadata.

The generator sees compact awareness or selected schemas, not the full catalog. Jev narrows candidates with a no-match/broaden path.

## 7. Permission engine

For every effectful action construct an immutable inspected-action record.

Semantic questions cover user authorization, destructive side effects, external transmission, scope mismatch, and insufficient inspection. Hard policy remains code. Timeout, malformed response, or uncertainty never becomes approval. Changing arguments or inspected contents invalidates the decision.

## 8. Routing

Routing considers the whole path: context selection/indexing, cached/uncached input, generation, worker execution, reintegration, and expected retries.

A cheaper model is not automatically a cheaper route. Destination policy applies before routing, including to Jev.

## 9. Workers and background processing

Workers receive a ContextView, not a copied parent transcript.

Read-only subscribers may share repository discovery/indexing while producing review findings, explanations, proposed evals/tests, or understanding pages. Every result is tied to a source snapshot; stale results are marked or rejected. Concurrent writers are initially out of scope.

## 10. Proposed layout

```
packages/
  agent/
  context/
  jev/
  capabilities/
  policy/
  routing/
  workers/
  execution/
  providers/
  telemetry/
apps/
  cli/
```

Shared modules should avoid Pi session internals so the extension track can reuse them.

## 11. Delivery

**A. Replay/evals:** evaluate Jev question families offline.

**B. Thin native agent:** real Pi-backed coding turn using a pi-jev ContextView, Jev permissions, tool discovery, and hierarchical history.

**C. Dynamic routing:** multiple generator models and worker-specific ContextViews.

**D. Background/batteries:** one native utility adapter and one read-only subscriber.

**E. Experimental:** heatmaps, recursive state, aggressive parallelization, richer synchronization.

## 12. Acceptance

This track is valid only if:
- pi-jev, not Pi, decides the model payload;
- old evidence can be recovered after leaving active context;
- hidden capabilities can be discovered lazily;
- Jev failure cannot authorize an unsafe action;
- routing includes handoff/context costs;
- traces make context/tool/routing decisions inspectable.

## 13. Tradeoff

**Strength:** maximum fidelity and experimental control.

**Cost:** pi-jev owns more lifecycle, integration, UI/session glue, and compatibility work.

This is the fallback and eventual destination if Pi's extension boundary prevents the TypeSafe-native control plane from being implemented cleanly.
