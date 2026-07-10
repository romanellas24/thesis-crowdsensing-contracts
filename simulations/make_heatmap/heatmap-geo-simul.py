"""
plot_decay_heatmap.py

Generates reward-decay heatmaps for the spatial simulation (§4.3).

For each N in SENDERS, produces a 2×2 figure (one subplot per k value)
showing the expected reward for the next CID in every chunk, colour-coded
from red (heavily decayed) to green (full reward).

Usage
-----
    python plot_decay_heatmap.py

Configuration
-------------
Edit the three constants below to match your directory layout.
"""

import json
import os
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as patches
import matplotlib.colors as mcolors
import matplotlib.cm as cm

#  Configuration 
RESULTS_DIR = "../../results/geo"   # directory containing geo_porto_N_kK*.json
OUTPUT_DIR  = "."   # where to write the PNG files
SENDERS     = [500, 1000] # which N values to plot
K_VALUES    = [1, 2, 3, 4]
CHUNK4SIDE  = 10
MAX_REWARD  = 1000        # dataSenderPayout (DST)
#


def load_decay(n: int, k: int) -> dict:
    path = os.path.join(RESULTS_DIR, f"geo_porto_{n}_k{k}_decay.json")
    with open(path) as f:
        return json.load(f)


def load_base(n: int) -> dict:
    """Load the base (non-decay) result to identify covered chunks."""
    path = os.path.join(RESULTS_DIR, f"geo_porto_{n}_k1.json")
    with open(path) as f:
        return json.load(f)


def rewards_to_grid(decay_data: dict, chunk4side: int = CHUNK4SIDE) -> np.ndarray:
    """
    Convert chunkExpectedRewards dict to a 2-D array.
    grid[row, col]: row 0 = southernmost row, col 0 = westernmost column.
    chunk_id = row * chunk4side + col  (matches contract indexing).
    """
    grid = np.full((chunk4side, chunk4side), float(MAX_REWARD))
    for chunk_id_str, reward in decay_data["chunkExpectedRewards"].items():
        chunk_id = int(chunk_id_str)
        row = chunk_id // chunk4side
        col = chunk_id % chunk4side
        grid[row, col] = float(reward)
    return grid


def find_most_saturated(base_data: dict) -> tuple[int, int]:
    """Return (chunk_id, count) of the chunk with the most CIDs."""
    dist = {int(k): v for k, v in base_data["results"]["chunkDistribution"].items()}
    return max(dist.items(), key=lambda x: x[1])


def plot_heatmap_figure(n: int) -> None:
    base_data   = load_base(n)
    max_pc      = base_data["config"]["maximumDataPerChunk"]
    covered_ids = {int(k) for k in base_data["results"]["chunkDistribution"]}
    hot_id, hot_count = find_most_saturated(base_data)
    hot_alpha   = hot_count / max_pc

    cmap = cm.RdYlGn                                      # red=low, green=high
    norm = mcolors.Normalize(vmin=0, vmax=MAX_REWARD)

    fig, axes = plt.subplots(2, 2, figsize=(14, 14), dpi=150)
    fig.suptitle(
        f"Expected reward for next CID — N = {n} senders\n"
        rf"$r = {MAX_REWARD} \cdot (1 - \alpha)^{{1/2^k}}$  (Eq. 2.4)"
        f"   |   most saturated: chunk {hot_id}  "
        rf"($\alpha = {hot_alpha:.3f}$)",
        fontsize=10, y=1.01
    )

    for idx, k in enumerate(K_VALUES):
        ax  = axes[idx // 2][idx % 2]
        dec = load_decay(n, k)
        grid = rewards_to_grid(dec)

        im = ax.imshow(grid, origin="lower", cmap=cmap, norm=norm, aspect="equal")

        #  Cell annotations 
        for row in range(CHUNK4SIDE):
            for col in range(CHUNK4SIDE):
                chunk_id = row * CHUNK4SIDE + col
                reward   = grid[row, col]

                # Text colour: black on mid-tones, white on extremes
                rel = (reward - 0) / MAX_REWARD
                txt_color = "black" if 0.25 < rel < 0.85 else "white"

                if chunk_id in covered_ids:
                    label = f"{int(reward)}"
                else:
                    label = "—"            # cold chunk: full reward, no data

                ax.text(col, row, label,
                        ha="center", va="center",
                        fontsize=8, color=txt_color)

        #  Highlight most-saturated chunk 
        hot_row = hot_id // CHUNK4SIDE
        hot_col = hot_id  % CHUNK4SIDE
        rect = patches.Rectangle(
            (hot_col - 0.5, hot_row - 0.5), 1, 1,
            linewidth=2.0, edgecolor="blue", facecolor="none", zorder=5
        )
        ax.add_patch(rect)

        #  Axes 
        hot_reward = int(grid[hot_row, hot_col])
        ax.set_title(
            f"k = {k}   |   chunk {hot_id}: {hot_reward} DST "
            f"({100 * hot_reward / MAX_REWARD:.0f}%)",
            fontsize=9
        )
        ax.set_xlabel("Column  (W → E)", fontsize=7)
        ax.set_ylabel("Row  (S → N)",    fontsize=7)
        ax.set_xticks(range(CHUNK4SIDE))
        ax.set_yticks(range(CHUNK4SIDE))
        ax.tick_params(labelsize=5.5)

        cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        cbar.set_label("Expected reward (DST)", fontsize=7)
        cbar.ax.tick_params(labelsize=6)
        cbar.set_ticks([0, 250, 500, 750, 1000])

    #  Legend note 
    fig.text(
        0.5, -0.01,
        f"Blue border = most saturated chunk (chunk {hot_id}, α = {hot_alpha:.3f}).  "
        f"'—' = cold chunk (0 CIDs submitted, reward always {MAX_REWARD} DST).",
        ha="center", fontsize=8, style="italic"
    )

    plt.tight_layout()
    out = os.path.join(OUTPUT_DIR, f"heatmap_decay_N{n}.png")
    plt.savefig(out, dpi=150, bbox_inches="tight")
    out = os.path.join(OUTPUT_DIR, f"heatmap_decay_N{n}.pdf")
    plt.savefig(out, dpi=150, bbox_inches="tight")
    print(f"Saved: {out}")
    plt.close()


if __name__ == "__main__":
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for n in SENDERS:
        plot_heatmap_figure(n)
        print(f"  Done N={n}")