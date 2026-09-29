# Vendored files

Used only when "의미 검색" (sentence-embedding search) is turned on.

| File | Source | License |
| --- | --- | --- |
| `transformers.min.js` | `@huggingface/transformers` 4.3.0, `dist/transformers.min.js` | MIT (Hugging Face), see `LICENSE-transformers.txt` |
| `ort-wasm-simd-threaded.asyncify.mjs` | `onnxruntime-web` 1.31.0-dev.20260914-8d85527a0, `dist/` | MIT (Microsoft) |

The matching WebAssembly binary (`ort-wasm-simd-threaded.asyncify.wasm`, ~27 MB) and the model
`Xenova/multilingual-e5-small` (~118 MB, 8-bit) are downloaded when the option is turned on.
