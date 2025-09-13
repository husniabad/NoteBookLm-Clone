// Simple in-memory cache for query embeddings
const queryCache = new Map<string, number[]>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cacheTimestamps = new Map<string, number>();

interface EmbeddingModel {
  embedContent?(text: string): Promise<{
    embedding: {
      values: number[];
    };
  }>;
}

export async function getCachedEmbedding(query: string, embeddingModel: EmbeddingModel): Promise<number[]> {
  const cached = getCachedEmbeddingSync(query);
  if (cached) return cached;
  
  if (!embeddingModel.embedContent) {
    throw new Error('Embedding model does not support embedContent');
  }
  const embeddingResult = await embeddingModel.embedContent(query);
  const embedding = embeddingResult.embedding.values;
  setCachedEmbedding(query, embedding);
  return embedding;
}

function getCachedEmbeddingSync(query: string): number[] | null {
  const cached = queryCache.get(query);
  const timestamp = cacheTimestamps.get(query);
  
  if (cached && timestamp && Date.now() - timestamp < CACHE_TTL) {
    return cached;
  }
  
  // Clean up expired entry
  if (cached) {
    queryCache.delete(query);
    cacheTimestamps.delete(query);
  }
  
  return null;
}

export function setCachedEmbedding(query: string, embedding: number[]): void {
  queryCache.set(query, embedding);
  cacheTimestamps.set(query, Date.now());
  
  // Simple cleanup: remove old entries when cache gets too large
  if (queryCache.size > 100) {
    const oldestKey = Array.from(cacheTimestamps.entries())
      .sort(([,a], [,b]) => a - b)[0][0];
    queryCache.delete(oldestKey);
    cacheTimestamps.delete(oldestKey);
  }
}