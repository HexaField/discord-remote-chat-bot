## Causal Pipeline

Implements the ADR specification for transforming qualitative text sources into a causal loop diagram (CLD) with provenance.

### Stages

1. Ingest: normalize documents & sentence spans (`ingest.ts`).
2. Open coding: extract candidate themes with evidence spans (`openCoding.ts`).
3. Axial coding: aggregate themes into variables & containment links (`axialCoding.ts`).
4. Causality: detect sentences with causal cues; produce directional edges with polarity + confidence (`causality.ts`).
5. Consolidate: merge duplicate edges, prune, build graph (`graph.ts`).
6. Loop discovery: find simple cycles; classify reinforcing/balancing (`loops.ts`).
7. Export: JSON graph, CSV nodes/edges, CLD (Mermaid), provenance HTML (`export.ts`).
8. Orchestrate: `runCausalPipeline` executes the stages (`pipeline.ts`).

### Data Model

Defined in `types.ts` (Document, Span, Code, Containment, CausalEdge, Graph, Loop, ExportBundle).

### Configuration

`config.ts` sets cue lexicon, variable mappings, synonyms, pruning threshold, and confidence weights. Provide partial overrides via `runCausalPipeline(..., { config: { ... } })`.

### Usage

```ts
import { runCausalPipeline } from './causal'

const { graph, loops, exports } = await runCausalPipeline([
  { id: 'doc1', text: 'Underperformance leads to resource allocation. Resource allocation increases performance. Performance reduces underperformance.' }
], { exportDir: 'out', baseName: 'example' })
```

### Determinism

Pipeline is rule-based (no LLM calls) to keep runs deterministic and fast; provenance spans preserve source offsets.

### Tests

Unit & integration tests live alongside modules (see `*.test.ts`). The integration test validates variables, edges, loops, and evidence.

### Future Improvements

* Smarter variable normalization (embedding similarity).
* Richer loop naming.
* Optional LLM-assisted theme merging behind a flag.
