// Simple in-memory cache for query embeddings
const queryCache = new Map<string, number[]>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cacheTimestamps = new Map<string, number>();

export function getCachedEmbedding(query: string): number[] | null {
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