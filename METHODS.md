# Spatial barcode decoding — method

How `scripts/convert-experiment.mjs` turns raw piseq/Mercury spatial counts into a
per-cell location and a confidence. Everything here is deterministic: no random
seeds, no iterative fitting, no hand-tuned thresholds beyond the two constants
declared in §5. Re-running the converter on the same inputs reproduces the file
byte-for-byte.

---

## 1. Inputs and notation

| symbol | meaning |
|---|---|
| `config_bit_scheme.csv` | one row per **submask**: its 5 **bits** (column `index`, 0-based) and its centre `(x, y)` in microns |
| `bc_i / count_i` | a **read pattern**: the set of bits detected in `count_i` reads of this cell |
| `no_bc` | reads with no spatial barcode at all (ambient / unbarcoded) |
| `B` | a submask, i.e. a set of exactly 5 bits |
| `R₂` | the cell's **co-occurrence reads** — reads whose pattern shows ≥ 2 bits |
| `W_j` | how many of those `R₂` reads contain bit `j` |
| `M = Σ_j W_j` | total co-occurrence bit-mass (a `k`-bit read contributes `k`) |
| `S_B = Σ_{j∈B} W_j` | co-occurrence support for submask `B` |

A spatial barcode is a **combination of 5 bits out of 20**. `C(20,5) = 15 504`;
Mercury emits the first `15 193` in lexicographic order, so the whitelist of real
submasks is 15 193, not all combinations.

## 2. Bit-label convention (`I{k}` ⇄ bit `k−1`)

Mercury writes bit labels **one-based**. From `_spatial_mapping.py::filter_cell_counts`,
which builds the label string for each config row and matches it against the assign file:

```python
indexes = pd.read_csv(bit_scheme_csv, usecols=['index'])['index'].tolist()
index = [(int(x) + 1) for x in index]          # <-- bit index + 1
barcode_seq += f"I{i}-" if i > 9 else f"I0{i}-"
```

So **`I01` → bit 0 … `I20` → bit 19**. This matters: the labels are the only bridge
between the counts file and the `(x, y)` table, and an off-by-one silently produces
a *plausible-looking but wrong* map (a shifted 5-subset is still a valid submask
~98% of the time, so validity checks alone cannot detect the error — only the source
convention, or agreement with `assigned`, can).

`I00` appears in 18 reads out of ~70 million and is discarded as an artefact.

## 3. Reachable hypothesis space

A bit that never appears in **any** co-occurrence read was never read out, so no cell
can ever be shown to carry it. In this run `I20` (bit 19) has zero reads, so the
3 717 submasks whose code requires it are unreachable. The converter derives this
from the data (`total support per bit > 0`) rather than assuming it, and restricts
the hypothesis space to

> **H** = { submasks whose 5 bits were all observed } — here **11 476** of 15 193.

`harmony`'s own `assigned` codes never contain `I20`, consistent with this.

## 4. Why single-bit reads are thrown away

A submask barcode is 5 bits that were applied **together**, so a read carrying the
barcode should show several of them at once. Two populations exist:

* **Co-occurrence reads** (≥ 2 bits) — carry the spatial signal.
* **Single-bit reads** — ambient/index-hopping background. They are near-uniform
  across bits and are *the majority of barcoded reads* in low-quality cells.

Concretely, cell `S1AACACGCT-A7` has 18 754 barcoded reads, **all singletons**, with
counts spread evenly over every bit (1857, 1646, 1091, 1083, 1064, …). Ranking bits
by their raw marginal count picks whichever bits happen to have the largest ambient
counts — a confident-looking answer built from noise. Restricting to co-occurrence
removes this failure mode entirely (A7 correctly ends up with *no* signal and is left
unplaced). Empirically this lifted agreement with harmony from **78.2% → 91.1%**.

## 5. The call and its confidence

For each cell with `R₂ > 0`:

**Point estimate.**

> `B* = argmax_{B ∈ H} S_B`

the submask whose 5 bits carry the most co-occurrence support. It is a plain
argmax over an explicit whitelist — no tie-breaking heuristics, no guessing.

**Distribution over locations.** Count differences carry Poisson noise, so the
margin between the winner and any other submask is measured in units of its own
standard error:

> `z_B = (S_{B*} − S_B) / √(S_{B*} + S_B + 1)`
> `w_B = exp(−z_B² / 2)`   (so `w_{B*} = 1`)

**Is there a barcode at all?** `purity` is the share of the cell's co-occurrence
bit-mass that lands on `B*`'s five bits, shrunk toward the value a structureless
cell would show:

> `purity = (S_{B*} + p₀·m) / (M + m)`,  `p₀ = 5/19`,  `m = 50`

`p₀` is the null value (5 of the 19 observable bits); `m = 50` pseudo-counts of
bit-mass keep a cell with a handful of reads from reading as 1.0. These are the
only two constants in the method.

**Final probabilities**, over `{no-call} ∪ H`:

> `P(B) = purity · w_B / Σ_{B′∈H} w_{B′}`
> `P(no-call) = 1 − purity`

`Σ_B P(B) = purity`, so the whole thing sums to 1. A clean cell puts nearly all mass
on one submask; a doublet splits it; an ambient cell keeps it near zero and the
`no-call` mass dominates. The converter writes every candidate with `P ≥ 0.02`
(top 6), each with its own `(x, y)` — that is what the viewer ghosts.

## 6. What this does on real cells

| cell | reads `R₂` | conf | behaviour |
|---|---|---|---|
| `B4` | 4 985 | 0.966 | one dominant 5-bit pattern; matches harmony |
| `E3` | 196 | 0.904 | clean, low depth; matches harmony |
| `G12` | 686 | 0.114 | **doublet** — two 5-bit codes at ~equal support, mass splits 6 ways |
| `E4` | 3 544 | 0.066 | only *pairs* co-occur, 8 submasks tie → correctly unresolved |
| `H4` | 34 | 0.070 | too little evidence; `no-call` = 0.17 |
| `A7` | 0 | — | no co-occurrence at all → **left unplaced, never guessed** |

## 7. Validation

* **Agreement with harmony's `assigned`** (its own independent, thresholded call):
  **3 930 / 4 313 = 91.1%**.
* **Calibration.** Against harmony's full candidate *ranking* on plate A01 (which
  ranks even the cells harmony refused to assign), agreement rises monotonically
  with our confidence:

  | confidence | agreement |
  |---|---|
  | 0.9 – 1.0 | 9/9 = **100%** |
  | 0.8 – 0.9 | 2/2 = 100% |
  | 0.2 – 0.3 | 2/2 = 100% |
  | 0.1 – 0.2 | 1/2 = 50% |
  | 0.0 – 0.1 | 15/76 = 20% |

  This is the property that makes the number usable: a confidence of 0.9 really does
  behave like 0.9.

Of 37 231 cells: **34 880 placed**, 2 351 have no co-occurrence signal and are
omitted. Confidence ≥ 0.9: 3 005; ≥ 0.5: 4 476; ≥ 0.05: 8 154 (median 0.002 — most
cells in this run genuinely do not have enough spatial signal to be pinned down, and
the method says so rather than inventing a location).

## 8. Alternatives considered and rejected

* **Marginal (all-reads) bit support.** Fooled by ambient singletons; 78.2% agreement.
  Rejected — see §4.
* **A strict Bernoulli/Bayesian posterior** `P(B) ∝ exp(T_B/φ)`, with `T_B` the per-bit
  log Bayes factor against a "no barcode" null. Correct in principle, but reads are PCR
  duplicates, so per-read evidence is massively overdispersed. Fitting the dispersion
  from the data (Pearson χ²/df, after modelling per-bit detection *and* ambient
  efficiencies) gives **φ ≈ 700**, which drives genuinely clean, harmony-confirmed cells
  (e.g. `E3`) to confidence 0.004. The top-20-pattern truncation of the counts file makes
  the molecule count — and hence `φ` — unidentifiable. Rejected as not defensible.
* **Per-bit ambient-bias correction.** Ambient propensity really does vary by bit
  (`I18` is 3.3× the mean, `I06` 0.31×). Subtracting the expected ambient
  (`W_j − R₂·α_c·a_j`) *lowered* agreement with harmony (90.4% vs 91.1%), so the simpler
  raw statistic is used. Kept as a diagnostic only.

## 9. Caveats

* **Confidence answers "which submask", not "is this the cell's own barcode".** A cell
  can have a crisp barcode carried by only 3% of its reads (`cooc_frac`). Those get high
  confidence here, and harmony often calls them `NA`. Filter on `cooc_frac` / `cooc_reads`
  if you want harmony-like stringency.
* **Many cells share a submask.** 7 593 of the 10 045 occupied submasks hold more than
  one cell (up to 237). Overlapping points are expected; the viewer lets you pick between
  them.
* Read counts are duplicates, not molecules; absolute depth (`cooc_reads`) is therefore
  a weak proxy for evidence.
* The counts file keeps only each cell's top-20 patterns, so very low-abundance
  co-occurrence is invisible. This can only *lose* signal, never invent it.

## 10. Reproducing

```sh
node scripts/convert-experiment.mjs <experimentFolder> <concatenated_spatial_counts_wide.txt>
```

Prints the observable bits, the size of the hypothesis space, the confidence
distribution and the harmony agreement, then writes `maplet/cells.tsv` +
`maplet/images.tsv` inside the experiment folder.

### Columns in `cells.tsv`

| column | meaning |
|---|---|
| `x`, `y` | submask centre of `B*` (microns). No `z` — one slide, one plane. |
| `spatial_barcode`, `_conf`, `_x`, `_y` | the call, `P(B*)`, and its location |
| `spatial_barcode_2…_6` (+ `_conf`,`_x`,`_y`) | other candidates with `P ≥ 0.02` |
| `no_call` | `1 − purity`: probability the cell has no identifiable barcode |
| `cooc_reads`, `cooc_frac` | `R₂`, and `R₂` / barcoded reads |
| `barcoded_reads`, `total_reads`, `no_bc_frac` | depth / ambient QC |
| `slide`, `plate`, `well` | library metadata (filterable; **not** spatial) |
| `assigned_barcode` | harmony's own call, for comparison |
