import { createHash } from "crypto";
import { createReadStream, existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

/**
 * Models are pinned like dependencies: a fixed Hugging Face commit plus the
 * SHA-256 of every file. Evals compare numbers across runs, so "the same
 * model" must mean the same bytes, not "whatever the hub serves today".
 */
export interface ModelSpec {
   id: string;
   revision: string;
   /** Relative path -> SHA-256. */
   files: Record<string, string>;
}

/** Sentence embeddings for logs and queries (bi-encoder, int8). */
export const EMBEDDING_MODEL: ModelSpec = {
   id: "Xenova/all-MiniLM-L6-v2",
   revision: "751bff37182d3f1213fa05d7196b954e230abad9",
   files: {
      "config.json": "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
      "tokenizer.json": "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
      "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
      "special_tokens_map.json": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
      "onnx/model_quantized.onnx": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
   },
};

/**
 * Cross-encoder for reranking (src/search/rerank.ts): reads the query and a
 * log together and outputs one relevance logit. fp32 on purpose: the int8
 * builds use dynamic quantization, so a pair's score would depend on the
 * other pairs in the batch (the same problem embedder.ts avoids).
 */
export const RERANKER_MODEL: ModelSpec = {
   id: "Xenova/ms-marco-MiniLM-L-6-v2",
   revision: "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
   files: {
      "config.json": "d827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e",
      "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      "tokenizer_config.json": "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53",
      "special_tokens_map.json": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
      "onnx/model.onnx": "c623d0bcb99f4622beb413eaef00cfbe5db20df9f1dd982da4b4f26022881870",
   },
};

export const MODELS = [EMBEDDING_MODEL, RERANKER_MODEL];

// The embedding model's names, used across the scripts and tests.
export const MODEL_ID = EMBEDDING_MODEL.id;
export const MODEL_REVISION = EMBEDDING_MODEL.revision;
export const MODEL_DTYPE = "q8"; // -> onnx/model_quantized.onnx (int8)
export const MODEL_FILES = EMBEDDING_MODEL.files;

/** Root folder that holds `<MODEL_ID>/...` (gitignored). */
export const MODELS_ROOT =
   process.env.EMBEDDING_MODELS_DIR ?? path.resolve(__dirname, "../../models");

export const modelDir = (spec: ModelSpec = EMBEDDING_MODEL) => path.join(MODELS_ROOT, spec.id);

function sha256(file: string): Promise<string> {
   return new Promise((resolve, reject) => {
      const h = createHash("sha256");
      createReadStream(file)
         .on("data", (c) => h.update(c))
         .on("end", () => resolve(h.digest("hex")))
         .on("error", reject);
   });
}

export interface VerifyResult {
   file: string;
   ok: boolean;
   reason?: string;
}

export async function verifyModel(spec: ModelSpec = EMBEDDING_MODEL): Promise<VerifyResult[]> {
   const results: VerifyResult[] = [];
   for (const [file, expected] of Object.entries(spec.files)) {
      const full = path.join(modelDir(spec), file);
      if (!existsSync(full)) {
         results.push({ file, ok: false, reason: "missing" });
         continue;
      }
      const actual = await sha256(full);
      results.push(
         actual === expected
            ? { file, ok: true }
            : { file, ok: false, reason: `sha256 ${actual} != ${expected}` },
      );
   }
   return results;
}

/**
 * Downloads the pinned files from the Hugging Face hub. Files already on
 * disk with the right SHA-256 are kept, so a file placed by hand (e.g. from
 * a verified mirror when the hub's CDN is blocked) isn't downloaded again.
 */
export async function fetchModel(spec: ModelSpec = EMBEDDING_MODEL): Promise<void> {
   for (const [file, expected] of Object.entries(spec.files)) {
      const full = path.join(modelDir(spec), file);
      if (existsSync(full) && (await sha256(full)) === expected) continue;
      const url = `https://huggingface.co/${spec.id}/resolve/${spec.revision}/${file}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, Buffer.from(await res.arrayBuffer()));
      console.log(`downloaded ${file}`);
   }
}
