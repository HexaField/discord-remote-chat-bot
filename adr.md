Build a TypeScript service that converts qualitative text into a causal loop diagram (CLD) with full provenance. Follow this specification exactly.

# References

- ./paper.md **“Using Textual Data in System Dynamics Model Conceptualization”**

# Objective

Implement a pipeline that ingests textual sources, performs open → axial coding, extracts aggregate causal relations with polarity and confidence, and outputs a causal graph and CLDs with clickable traceability to original text. The method emphasizes causal relationships early, aggregates links to reduce effort, and preserves links back to sources via software.

# Scope

- Input: plain text transcripts or documents.
- Output:
  - Coding tree (themes → variables) with containment links.
  - Causal edges between variables with polarity, confidence, and source spans.
  - Identified feedback loops classified as reinforcing or balancing.

- Out of scope: exporting artifacts, model simulation or quantitative calibration.

# Method alignment

- Use grounded-theory inspired open and axial coding. Open = identify concepts; Axial = organize hierarchically and relate categories.
- Preserve causal focus from the start, aggregate relationships at variable level, and maintain source links.
- Final deliverable includes CLDs summarizing mechanisms as in the paper’s examples.

# Data model (conceptual)

- `Document`: id, title, metadata, text, source URI.
- `Span`: docId, start, end, textPreview.
- `Code`: id, label, type ∈ {theme, variable}, group ∈ {policy, industry, users, local_authority, other}, notes.
- `Containment`: parentCodeId, childCodeId, relation = "contains" (non-causal).
- `CausalEdge`: fromVariableId, toVariableId, polarity ∈ {+, −}, confidence ∈ [0,1], evidence: Span[], notes.
- `Graph`: variable nodes + causal edges, derived from codes and relationships.
- `Loop`: id, nodeIds[], edgeIds[], type ∈ {reinforcing, balancing}, evidence: edgeIds.
- `ExportBundle`: graph JSON, CLD image, CSVs (nodes, edges), provenance HTML.

# Processing pipeline

1. **Ingest**
   - Accept one or more text files. Normalize encoding. Segment into sentences.

2. **Open coding**
   - Identify candidate themes from sentences. Produce `Code` entries of type `theme`. Keep Span links for every theme occurrence. (Grounded-theory open coding.)

3. **Axial coding / aggregation**
   - Assign themes to actor groups and aggregate them into model variables. Create `Code` entries of type `variable`. Link themes to variables with `Containment` relations. (Hierarchical containment, not causal.)

4. **Causality extraction**
   - Detect causal cues in sentences.
   - Map mentions in causal sentences to variables.
   - Create `CausalEdge` at variable level with:
     - polarity (+/−),
     - confidence score,
     - evidence Spans.

   - Preserve references to all originating text passages. (Maintain links to sources.)

5. **Graph consolidation**
   - Merge parallel edges, union evidence, aggregate confidence.
   - Prune edges below configurable confidence threshold.
   - Collapse synonymous variables per mapping rules.

6. **Loop discovery**
   - Find simple cycles.
   - Compute loop sign by multiplying edge polarities; label as reinforcing or balancing. (Produce CLDs summarizing mechanisms.)

7. **Rendering and export**
   - Layout graph grouped by actor groups.
   - Render CLD with edge polarity indicators and loop badges.
   - Export:
     - Graph JSON,
     - CLD image (SVG/PNG),
     - CSV reports,
     - Provenance bundle that makes each edge clickable to reveal source quotes.

# Configuration

- Causal cue lexicon and regexes.
- Theme → variable mappings and synonym lists.
- Actor-group assignment rules.
- Confidence aggregation strategy.
- Pruning thresholds.
- Export formats and output directories.

# Interfaces

# Functional requirements

- Open coding generates themes and attaches Span evidence.
- Axial coding builds a hierarchical containment tree.
- Causal extraction operates at the aggregate variable level, not per-instance, to reduce effort while retaining traceability.
- Provenance preserved for every edge with one or more Spans.
- Loop detection classifies loops by sign and names them deterministically.
- Exports include a machine-readable graph and a visual CLD.

# Non-functional requirements

- Deterministic runs with same inputs and config.
- Process large corpora without crashes.
- Explicit error reporting and JSON logs.
- Modular packages, unit-testable functions.
- Clear separation between containment links and causal edges.

# Validation and QA

- **Unit tests**
  - Sentence segmentation and Span integrity.
  - Theme creation and containment tree construction.
  - Causal cue detection and polarity classification.
  - Edge merge and confidence aggregation.
  - Loop sign classification.

- **Fixture-based tests**
  - Provide small transcripts that must yield known edges and loops reflecting mechanisms like:
    - “Underperformance triggers resource allocation” (balancing).
    - “Underperformance triggers scrapping” (reinforcing).
    - “Low performance triggers better design” and rework effects.

  - Assert edge provenance includes expected quotes.

- **End-to-end tests**
  - Run full pipeline on a sample corpus. Validate:
    - Non-empty variables and edges,
    - Loops detected and typed,
    - CLD exported,
    - Provenance bundle resolves edge → quote.

# Deliverables

- A single TypeScript function implementing the pipeline (in many smaller functions).
- Unit and integration tests with coverage reports.
- Sample input corpus and expected outputs.
- Documentation describing usage, configuration, and mapping to the paper’s methodology.

# Acceptance criteria

- Running the pipeline on the sample corpus yields:
  - A containment tree with ≥10 variables and correct parent-child relations.
  - ≥1 reinforcing and ≥1 balancing loop identified.
  - Each causal edge has ≥1 evidence Span with correct offsets.
  - CLD image renders with polarity and loop badges.
  - Exports include graph JSON, CSVs, and provenance HTML.

- All tests pass locally.
- Documentation describes how each stage maps to the grounded-theory steps and the paper’s methodological emphasis on early causal focus, aggregation, and maintained links.

# Notes for implementer

- Preserve a strict distinction between containment (“contains”) and causality (“causes”). Containment is hierarchical organization for themes and variables; causality is directional with polarity.
- The goal is a time-efficient, auditable workflow: fewer granular edges, stronger provenance.

Use this as the sole build contract.
