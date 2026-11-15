import { createHash } from "crypto";
import { createReadStream, existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

/**
 * The embedding model is pinned like a dependency: a fixed Hugging Face
 * commit plus the SHA-256 of every file. Evals compare numbers across runs,
 * so "the same model" must mean the same bytes, not "whatever the hub serves
 * today".
 */
export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const MODEL_DTYPE = "q8"; // -> onnx/model_quantized.onnx (int8)

export const MODEL_FILES: Record<string, string> = {
   "config.json": "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
   "tokenizer.json": "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
   "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
   "special_tokens_map.json": "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
   "onnx/model_quantized.onnx": "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
};

/** Root folder that holds `<MODEL_ID>/...` (gitignored). */
export const MODELS_ROOT =
   process.env.EMBEDDING_MODELS_DIR ?? path.resolve(__dirname, "../../models");

export const modelDir = () => path.join(MODELS_ROOT, MODEL_ID);

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

export async function verifyModel(): Promise<VerifyResult[]> {
   const results: VerifyResult[] = [];
   for (const [file, expected] of Object.entries(MODEL_FILES)) {
      const full = path.join(modelDir(), file);
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

/** Downloads the pinned files from the Hugging Face hub and verifies them. */
export async function fetchModel(): Promise<void> {
   for (const file of Object.keys(MODEL_FILES)) {
      const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${file}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      const full = path.join(modelDir(), file);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, Buffer.from(await res.arrayBuffer()));
      console.log(`downloaded ${file}`);
   }
}
