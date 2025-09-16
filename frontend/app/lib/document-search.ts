import { sql } from '@/app/lib/vercel-postgres';
// import { getCachedEmbedding } from '@/app/lib/query-cache';
// import { QueryAnalysis, SmartKeywords } from './query-analyzer';

export interface Chunk {
  content: string;
  page_number: number;
  document_id: string;
}

interface PageBlueprint {
  page_number: number;
  page_dimensions: { width: number; height: number };
  content_blocks: unknown[];
  combined_markdown: string;
}

interface EmbeddingModel {
  embedContent(content: string): Promise<{ embedding: { values: number[] } }>;
}

export interface BlueprintDocument {
  id: string;
  source_file: string;
  blueprint: PageBlueprint[] | { type: string; blob_url: string };
  pdf_url?: string;
}

export class DocumentSearchService {
  static async searchDocuments(
    sessionId: string,
    message: string,
    embeddingModel: EmbeddingModel
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
    
    if (documentIds.length === 0) {
      return { retrievedChunks, blueprints: [] };
    }
    
    const blueprintPromises = documentIds.map(docId => 
      sql<BlueprintDocument>`
        SELECT id, source_file, blueprint, pdf_url
        FROM documents
        WHERE id = ${docId}
      `
    );
    
    const blueprintResults = await Promise.all(blueprintPromises);
    const blueprints = blueprintResults.flatMap(result => result.rows);
    
    return { retrievedChunks, blueprints };
  }


}