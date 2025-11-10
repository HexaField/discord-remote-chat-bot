## Methodology mapping

This pipeline follows Eker & Zimmermann (2016) "Using Textual Data in System Dynamics Model Conceptualization" with a hybrid of grounded-theory steps:

- Open coding: identify themes with sentence-level spans
- Axial coding: build a coding tree by aggregating themes → variables and containment links
- Causality detection: extract aggregate causal relations with polarity and confidence using a cue lexicon and directional parsing
- Loop discovery: identify and type feedback loops (reinforcing/balancing)
- Provenance: every edge stores one or more source spans with document id and offsets

### Design choices

- Aggregate at variable level early to reduce effort (no per-instance links), while preserving span provenance.
- Deterministic rule-based extraction (no LLM) for testability and reproducibility.
- Configurable lexicon, mappings, synonyms, and pruning.

See `adr.md` at the repository root for acceptance criteria and the reference paper in `paper.md`.
