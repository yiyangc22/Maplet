# Regenerate the sample (sample-data/merfish-hypothalamus.cells.tsv) from squidpy's
# MERFISH mouse-hypothalamus dataset (Moffitt et al., 2018). Requires:
# pip install squidpy scanpy.
#
# Data: Moffitt et al., Science 2018 (doi:10.1126/science.aau5324); source data on Dryad
# (doi:10.5061/dryad.8t8s248), released under CC0 1.0 — free to reuse, please cite the paper.
#
#   python sample-data/make-merfish-sample.py
#
# Emits a plain CSV/TSV using the ORIGINAL reference dataset's obs column names (no
# type tokens). cat_prototype_10 asks the user to map columns to coordinates/variables
# when the file loads, so the header carries no notation. Columns:
#   Centroid_X / Centroid_Y / Centroid_Z  a 3-D spatial map. The raw sections are
#                       imaged at different stage positions (Centroid_X/Y are global
#                       montage coords), so each Bregma section is re-centered on a
#                       shared origin (a crude registration) to align the serial
#                       sections; Centroid_Z then stacks them by anterior-posterior
#                       (Bregma) order into a legible 2.5-D volume. Z = Bregma_raw * 40
#                       (sections ~200 um apart), scaled so the thin sections separate.
#   UMAP_1 / UMAP_2     a 2-D UMAP embedding (computed here with scanpy; none ships in
#                       the raw data), so the spatial view and the embedding stay linked.
#   Cell_class (16), Bregma (12 sections, numeric mm), Neuron_cluster_ID (70) —
#                       categorical / identifier variables to colour and filter by.
#   Gad1 / Slc17a6 / Aqp4 / Esr1 / total_counts — numeric gradients.
# On load, the app auto-proposes: Centroid_X/Y/Z -> map 0 (3-D), UMAP_1/2 -> map 1;
# tweak in the assignment dialog (e.g. set Bregma categorical to filter by section).

import os

import numpy as np
import pandas as pd
import scanpy as sc
import squidpy as sq

SEED = 0
Z_SCALE = 40.0  # um per Bregma unit; Bregma steps are 5 -> sections 200 um apart
MARKERS = ["Gad1", "Slc17a6", "Aqp4", "Esr1"]  # inhibitory / excitatory / astrocyte / hypothalamic-ER

ad = sq.datasets.merfish()

# Real genes only (drop the 5 Blank_* control barcodes) for expression + UMAP.
real_genes = [g for g in ad.var_names if not str(g).lower().startswith("blank")]
work = ad[:, real_genes].copy()


def dense(x):
    return x.toarray() if hasattr(x, "toarray") else np.asarray(x)


Xr = dense(work.X)
total_counts = Xr.sum(1)
marker_idx = {m: real_genes.index(m) for m in MARKERS}

# UMAP on a normalized/scaled copy (keeps `work` as raw expression for the __grad cols).
u = work.copy()
sc.pp.normalize_total(u, target_sum=1e4)
sc.pp.log1p(u)
sc.pp.scale(u, max_value=10)
sc.pp.pca(u, n_comps=50, svd_solver="arpack", random_state=SEED)
sc.pp.neighbors(u, n_neighbors=15, random_state=SEED)
sc.tl.umap(u, random_state=SEED)
um = np.asarray(u.obsm["X_umap"], dtype=float)

sp_x = np.asarray(ad.obs["Centroid_X"], dtype=float).copy()
sp_y = np.asarray(ad.obs["Centroid_Y"], dtype=float).copy()
bregma = np.asarray(ad.obs["Bregma"], dtype=float)

# Re-center each Bregma section on a shared origin so the serial sections align and
# overlap in-plane, separated only along z -> a clean stacked volume instead of the
# raw 2x6 stage montage.
for b in np.unique(bregma):
    m = bregma == b
    sp_x[m] -= sp_x[m].mean()
    sp_y[m] -= sp_y[m].mean()

neuron = ad.obs["Neuron_cluster_ID"].astype(str).replace({"nan": "", "NaN": "", "None": ""}).values

cols = {
    "id": [f"cell_{i:05d}" for i in range(ad.n_obs)],
    "Centroid_X": np.round(sp_x, 1),
    "Centroid_Y": np.round(sp_y, 1),
    "Centroid_Z": np.round(bregma * Z_SCALE, 1),
    "UMAP_1": np.round(um[:, 0], 3),
    "UMAP_2": np.round(um[:, 1], 3),
    "Cell_class": ad.obs["Cell_class"].astype(str).values,
    "Bregma": np.round(bregma / 100.0, 2),  # numeric section position in mm
    "Neuron_cluster_ID": neuron,
}
for m in MARKERS:
    cols[m] = np.round(Xr[:, marker_idx[m]], 1)
cols["total_counts"] = np.round(total_counts, 1)

df = pd.DataFrame(cols)

out = os.path.join(os.path.dirname(__file__), "merfish-hypothalamus.cells.tsv")
df.to_csv(out, sep="\t", index=False)

print(f"wrote {out}")
print(f"  {df.shape[0]:,} cells x {df.shape[1]} cols, {os.path.getsize(out) / 1e6:.1f} MB")
print(f"  cell classes: {df['Cell_class'].nunique()}   neuron clusters: {df['Neuron_cluster_ID'].nunique()}")
print(f"  bregma sections (mm): {sorted(df['Bregma'].unique())}")
print(f"  z range (um): {df['Centroid_Z'].min()} .. {df['Centroid_Z'].max()}")
print("  header: " + "\t".join(df.columns))
print("  row0:   " + "\t".join(str(v) for v in df.iloc[0].tolist()))
