import { sql } from '@/app/lib/vercel-postgres';
import { getCachedEmbedding } from '@/app/lib/query-cache';
import { QueryAnalysis, SmartKeywords } from './query-analyzer';

export interface Chunk {
  content: string;
  page_number: number;
  document_id: string;
}

export interface BlueprintDocument {
  id: string;
  source_file: string;
  blueprint: any;
}

export class DocumentSearchService {
  static async searchDocuments(
    sessionId: string,
    message: string,
    embeddingModel: any
  ): Promise<{ retrievedChunks: Chunk[], blueprints: BlueprintDocument[] }> {
    
    // 1. Find relevant chunks via vector search
    const queryEmbedding = await embeddingModel.embedContent(message);
    const chunkResults = await sql<Chunk>`
      SELECT c.content, c.page_number, c.document_id
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE d.session_id = ${sessionId}
      ORDER BY c.embedding <=> ${JSON.stringify(queryEmbedding.embedding.values)}::vector
      LIMIT 5
    `;
    const retrievedChunks = chunkResults.rows;

    if (retrievedChunks.length === 0) {
      return { retrievedChunks: [], blueprints: [] };
    }

    // 2. Get the full blueprints for the parent documents
    const documentIds = [...new Set(retrievedChunks.map(chunk => chunk.document_id))];
    const blueprintResults = await sql<BlueprintDocument>`
      SELECT id, source_file, blueprint
      FROM documents
      WHERE id = ANY(${documentIds})
    `;
    const blueprints = blueprintResults.rows;
    
    return { retrievedChunks, blueprints };
  }


}