import { inatGet } from "./inat";

/**
 * Batched iconic-taxon lookup. iNat's `/v1/taxa/{ids}` endpoint accepts at
 * most **30** ids per request — verified empirically (30 → 200, 31 → 422
 * "Too many IDs") — so batches are 30 and failures skip only their batch.
 */

export const TAXA_BATCH_SIZE = 30;

/** Batch a list of taxon ids into API-sized chunks. */
export function chunkTaxaIds(taxonIds: number[]): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < taxonIds.length; i += TAXA_BATCH_SIZE) {
    chunks.push(taxonIds.slice(i, i + TAXA_BATCH_SIZE));
  }
  return chunks;
}

/** Batch-fetch `iconic_taxon_id` for many taxa; one cached request per 30. */
export async function fetchIconicTaxa(
  taxonIds: number[],
): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  for (const chunk of chunkTaxaIds(taxonIds)) {
    try {
      const json = await inatGet<{ results: Array<{ id: number; iconic_taxon_id?: number }> }>(
        `taxa/${chunk.join(",")}`,
      );
      for (const t of json.results) {
        out.set(t.id, t.iconic_taxon_id ?? null);
      }
    } catch {
      // Leave this batch unclassified; a later run finishes it.
    }
  }
  return out;
}
