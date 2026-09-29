"""Optional local dense-embedding scorer for tools/benchmark-lore.mjs.

Install sentence-transformers in a temporary environment and cache the model first.
The fixture is synthetic; this script never sends text to an embedding API.
"""

import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer


MODEL = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"
FIXTURE = Path(__file__).resolve().parents[1] / "test/fixtures/lore-benchmark.json"
CACHE = Path.home() / ".cache/huggingface/hub/models--sentence-transformers--paraphrase-multilingual-mpnet-base-v2/snapshots"


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python tools/benchmark-lore-embeddings.py /path/to/scores.json")
    if not CACHE.exists():
        raise SystemExit(f"cached model missing: {CACHE}")
    snapshots = sorted(path for path in CACHE.iterdir() if path.is_dir())
    if not snapshots:
        raise SystemExit(f"cached model missing: {CACHE}")

    torch.set_num_threads(min(4, torch.get_num_threads()))
    data = json.loads(FIXTURE.read_text())
    lores, cases = data["lores"], data["cases"]
    start = time.perf_counter()
    model = SentenceTransformer(str(snapshots[-1]), local_files_only=True)
    load_seconds = time.perf_counter() - start

    lore_texts = [f"{item['title']} {' '.join(item['keywords'])} {item['content']}" for item in lores]
    start = time.perf_counter()
    lore_vectors = model.encode(lore_texts, normalize_embeddings=True)
    index_seconds = time.perf_counter() - start

    scores = {}
    query_ms = []
    for case in cases:
        query = case["query"] + (" " + case["recent"] if case.get("recent") else "")
        start = time.perf_counter()
        query_vector = model.encode(query, normalize_embeddings=True)
        similarity = np.asarray(lore_vectors @ query_vector)
        query_ms.append((time.perf_counter() - start) * 1000)
        scores[case["id"]] = {
            lore["id"]: float(similarity[index]) for index, lore in enumerate(lores)
        }

    output = {
        "model": MODEL,
        "dimensions": int(lore_vectors.shape[1]),
        "model_load_seconds": load_seconds,
        "lore_index_seconds": index_seconds,
        "query_ms_median": statistics.median(query_ms),
        "query_ms_p95": sorted(query_ms)[int(0.95 * (len(query_ms) - 1))],
        "scores": scores,
    }
    Path(sys.argv[1]).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in output.items() if key != "scores"}, indent=2))


if __name__ == "__main__":
    main()
