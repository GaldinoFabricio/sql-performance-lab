import { cpus } from "os";
import {
   env,
   pipeline,
   type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { MODEL_DTYPE, MODEL_ID, MODELS_ROOT } from "./model";

/** Must match the vector(384) column in the logs migration. */
export const EMBEDDING_DIM = 384;

// Offline by design: the model is read only from the pinned, verified files
// under MODELS_ROOT (`pnpm model:fetch`). No silent download of a different
// revision in the middle of an experiment.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODELS_ROOT;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
   extractor ??= pipeline("feature-extraction", MODEL_ID, {
      dtype: MODEL_DTYPE,
      session_options: {
         // Measured on a 4-core i3: one op at a time, all cores inside it.
         intraOpNumThreads: Number(process.env.EMBEDDING_THREADS ?? cpus().length),
         interOpNumThreads: 1,
      },
   }) as Promise<FeatureExtractionPipeline>;
   return extractor;
}

/**
 * Embeds texts with mean pooling + L2 normalization (how all-MiniLM-L6-v2
 * was trained). Normalized vectors mean cosine distance == 1 - dot product.
 * Returns vectors in the same order as `texts`.
 *
 * One text per model call, on purpose. The int8 model uses *dynamic*
 * quantization: activation scales are computed over the whole input tensor,
 * so a text's vector changes with whatever else is in the batch (measured:
 * cosine down to 0.98 vs. embedding it alone). Batching was ~35% faster, but
 * then a log searched by its own text would not be at distance 0 from its
 * stored vector, and evals would measure batch noise. Determinism wins.
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
   const ext = await getExtractor();
   const out: Float32Array[] = [];
   for (const text of texts) {
      const tensor = await ext(text, { pooling: "mean", normalize: true });
      out.push((tensor.data as Float32Array).slice(0, EMBEDDING_DIM));
      tensor.dispose();
   }
   return out;
}

/** pgvector text format: '[0.1,0.2,...]'. */
export function toPgVector(v: ArrayLike<number>): string {
   return `[${Array.from(v).join(",")}]`;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
   let dot = 0;
   let na = 0;
   let nb = 0;
   for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
   }
   return dot / Math.sqrt(na * nb);
}
