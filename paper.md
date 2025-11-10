**“Using Textual Data in System Dynamics Model Conceptualization”**:

---

# Using Textual Data in System Dynamics Model Conceptualization

**Authors:** Sibel Eker and Nici Zimmermann
**Affiliation:** UCL Institute for Environmental Design and Engineering, The Bartlett School of Environment, Energy and Resources, University College London
**Contact:** [s.eker@ucl.ac.uk](mailto:s.eker@ucl.ac.uk), [n.zimmermann@ucl.ac.uk](mailto:n.zimmermann@ucl.ac.uk)
**Academic Editor:** Ockie Bosch
**Received:** 2 June 2016 | **Accepted:** 28 July 2016 | **Published:** 4 August 2016
**DOI:** [10.3390/systems4030028](https://doi.org/10.3390/systems4030028)

---

## Abstract

Qualitative data is an important source of information for system dynamics modeling. It can potentially support any stage of the modeling process, yet it is mainly used in early steps such as problem identification and model conceptualization. Existing systematic approaches are often avoided due to time constraints from large datasets. This paper introduces an alternative approach that:

1. Focuses on causal relationships from the initial steps of coding,
2. Generates a generalized causal map without recording individual relationships,
3. Maintains links from the final causal map to data sources using software.

An application is demonstrated in a study about integrated decision-making in the UK housing sector.

**Keywords:** system dynamics, model conceptualization, textual data, qualitative data, coding

---

## 1. Introduction

Qualitative data plays a major role in system dynamics (SD) modeling, especially in the conceptualization phase. Interviews are the main technique used to collect such data. Interviews can either derive causal maps directly or inform model conceptualization without a formalized process. However, adopting formal methods can make qualitative data more effectively usable.

Grounded theory, as developed by Strauss and Corbin (1998), supports theory building from data and enables system dynamicists to link model elements to stakeholder information explicitly.

### Previous Approaches

* **Kim and Andersen (2012):** Developed a five-step grounded theory coding method for SD.
* **Turner et al. (2013):** Simplified Kim and Andersen’s approach to save time but omitted data linkage.
* **Yearworth and White (2013):** Used computer-aided qualitative data analysis software (CAQDAS) to maintain data links.

### This Study’s Contribution

A hybrid method combining the strengths of prior work:

* Focused on causal coding,
* Generalized causal maps (not individual relationships),
* Maintained source links via CAQDAS.

---

## 2. Materials and Methods

### 2.1 Integrated Decision Making in the UK’s Housing Sector

The UK housing sector is key to climate change mitigation. Despite policy efforts, results often fall short due to unintended consequences (e.g., poor air quality, rebound effects). To address this, systems thinking is recommended.

Researchers conducted 16 semi-structured interviews (Feb–Oct 2015) with diverse stakeholders from government, NGOs, academia, and industry. Each interview (1–2 hours, total 21 hours) focused on organizational roles, mission, integration, and delivery frameworks. Transcripts (≈155,800 words) were analyzed as textual data.

### 2.2 Coding Approach

This study adapts **Kim and Andersen (2012)** with modifications:

* **No individual causal recording or reference table** (reduces labor).
* **Maintains source links via CAQDAS** (NVivo 11).

#### Research Design Summary

| Dimension                        | Option Used  |
| -------------------------------- | ------------ |
| Communication                    | Asynchronous |
| Group Type                       | Many groups  |
| Context Setter                   | Researcher   |
| Data Collector                   | Researcher   |
| Coder Count                      | One          |
| Coder Engaged in Data Collection | No           |

#### Coding Workflow

| Step | Description                                   | Output               |
| ---- | --------------------------------------------- | -------------------- |
| 1    | Open coding – identify concepts/themes        | List of codes        |
| 2    | Axial coding – categorize and aggregate       | Coding tree          |
| 3    | Define causal relationships between variables | Coding dictionary    |
| 4    | Build causal maps                             | Final causal diagram |

NVivo was used for hierarchical coding, linking relationships to data, and memoing coder assumptions.

---

## 3. Results

The coding approach was applied to understand **fragmentation in the UK housing sector**.

### Step 1: Open Coding

Extracted key themes and implicit concepts (e.g., “trust in local engineers” and “community engagement by small firms”).

### Step 2: Categorizing and Aggregating

Created parent categories for actor groups:

* **Policy**
* **Industry**
* **User**
* **Local authorities**
* **Building performance**

Example hierarchy under *Competence of policy analysts*:

| Theme                 | Example Quote                                                               |
| --------------------- | --------------------------------------------------------------------------- |
| Multidisciplinarity   | “They didn’t engage the social and behavioral science people…”              |
| Multi-faceted scope   | “Building regulations talk about U-values, not whole-building performance.” |
| Workforce circulation | “Policy people move fast; corporate memory is weak.”                        |

### Step 3: Identifying Causal Relationships

Defined causal links between aggregate variables:

* *Learning* increases with *time spent in a role*.
* *Competence* improves with *multidisciplinarity* and *experience*.
* NVivo relationships were color-coded (green = positive, red = negative).

### Step 4: Transforming into Causal Diagrams

Relationships were visualized in causal loop diagrams (via Vensim).

**Example Loops:**

* **Reinforcing:** “Experiential learning through mistakes”
* **Balancing:** “Success limits learning”

Additional mechanisms:

* *Underperformance triggers resource allocation* (balancing)
* *Underperformance triggers scrapping* (reinforcing)
* *Low performance triggers better design* (industry feedback)
* *Rework increases capabilities* (balancing)

---

## 4. Discussion

### Use of Software and Quantitative Tools

CAQDAS improves transparency and reproducibility. Integration with visualization tools (e.g., Vensim) is valuable. Future integration of **text mining** and **topic modeling** could further accelerate coding.

### Validity and Reliability

Combining open and axial coding enhances efficiency but risks abstraction errors. Future studies should:

* Compare detailed vs. aggregated coding outcomes,
* Examine handling of conflicting stakeholder views,
* Quantify inter-coder reliability.

### Summary

The proposed method:

* Increases transparency via software,
* Reduces time effort,
* Retains linkages between causal models and data.

---

## Acknowledgments

Funded by the **EPSRC CBES Platform Grant** (“The Unintended Consequences of Decarbonising the Built Environment”). The authors thank Lai Fong Chiu and the reviewers for their contributions.

---

## Author Contributions

* **N.Z.**: Designed and conducted interviews
* **S.E. & N.Z.**: Analyzed data and wrote the paper

---

## Conflicts of Interest

None declared.

---

## Abbreviations

| Abbreviation | Meaning                                           |
| ------------ | ------------------------------------------------- |
| MDPI         | Multidisciplinary Digital Publishing Institute    |
| SD           | System Dynamics                                   |
| CAQDAS       | Computer-Aided Qualitative Data Analysis Software |

---

## Appendix A. Comparison of Coding Results

Comparison between coders’ interpretations shows minor differences in text fragment lengths and aggregation but similar conceptual coding.

---

## References

Key references include:

* Forrester (1992) – *Eur. J. Oper. Res.*
* Luna-Reyes & Andersen (2003) – *Syst. Dyn. Rev.*
* Kim & Andersen (2012) – *Syst. Dyn. Rev.*
* Yearworth & White (2013) – *Eur. J. Oper. Res.*
* DECC (2015) – *Energy Efficiency Statistical Summary*
* Macmillan et al. (2016) – *Environ. Health*
* Blei & Lafferty (2009) – *Topic Models*

Licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)
