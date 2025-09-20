import { sql } from '@/app/lib/vercel-postgres';
import { getCachedEmbedding } from '@/app/lib/query-cache';
import { QueryAnalysis, SmartKeywords } from './query-analyzer';

export interface Chunk {
  content: string;
  page_number: number;
  document_id: string;
  [key: string]: string | number | unknown; 
}

interface PageBlueprint {
  page_number: number;
  page_dimensions: { width: number; height: number };
  content_blocks: unknown[];
  combined_markdown: string;
}

interface EmbeddingModel {
  embedContent(content: string | string[]): Promise<{ embedding: { values: number[] } }>;
}

export interface BlueprintDocument {
  id: string;
  source_file: string;
  blueprint: PageBlueprint[] | { type: string; blob_url: string };
  pdf_url?: string;
}

export class DocumentSearchService {
  private static async keywordSearch(sessionId: string, keywords: string[], whereClause: string): Promise<Chunk[]> {
    const keywordClauses = keywords.map(kw => `LOWER(c.content) LIKE '%${kw.toLowerCase()}%'`);
    const keywordQuery = `
      SELECT c.content, c.page_number, c.document_id
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE d.session_id = '${sessionId}' AND (${keywordClauses.join(' OR ')})
      ${whereClause ? `AND ${whereClause}` : ''}
      LIMIT 5
    `;
    const results = await sql.query(keywordQuery);
    return results.rows as Chunk[];
  }

  static async searchDocuments(
    sessionId: string,
    message: string,
    embeddingModel: EmbeddingModel,
    analysis: QueryAnalysis,
    smartKeywords: SmartKeywords,
    pageNumbers: number[]
  ): Promise<{ retrievedChunks: Chunk[], blueprints: BlueprintDocument[] }> {
    
    const allChunks: Chunk[] = [];
    const searchLimit = 10; // Increase limit to accommodate multiple sources

    // 1. Construct dynamic WHERE clause for semantic search
    const whereClauses: string[] = [];
    if (analysis.isImageSpecific) {
      // whereClauses.push(`d.type = 'image'`);
    }
    if (analysis.focusStandaloneOnly) {
        const latestDoc = await sql`SELECT id FROM documents WHERE session_id = ${sessionId} ORDER BY created_at DESC LIMIT 1`;
        if (latestDoc.rows.length > 0) {
            whereClauses.push(`d.id = '${latestDoc.rows[0].id}'`);
        }
    }
    const whereClause = whereClauses.join(' AND ');

    // 2. Direct lookup for specific page numbers
    if (pageNumbers && pageNumbers.length > 0) {
      const pageQuery = `
        SELECT c.content, c.page_number, c.document_id
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE d.session_id = '${sessionId}'
        AND c.page_number IN (${pageNumbers.join(',')})
        ${whereClause ? `AND ${whereClause}` : ''}
      `;
      const pageResults = await sql.query(pageQuery);
      allChunks.push(...(pageResults.rows as Chunk[]));
    }

    // 3. Decide semantic search strategy: Multi-query vs. Single query
    const searchQueries = (analysis.isComplex && analysis.subQueries && analysis.subQueries.length > 0)
      ? analysis.subQueries
      : [message];

    // 4. Execute semantic searches
    for (const query of searchQueries) {
      const queryEmbedding = await getCachedEmbedding(query, embeddingModel);
      const vectorQuery = `
        SELECT c.content, c.page_number, c.document_id
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE d.session_id = '${sessionId}'
        ${whereClause ? `AND ${whereClause}` : ''}
        ORDER BY c.embedding <=> '${JSON.stringify(queryEmbedding)}'::vector
        LIMIT ${Math.floor(searchLimit / searchQueries.length)}
      `;
      const chunkResults = await sql.query(vectorQuery);
      allChunks.push(...(chunkResults.rows as Chunk[]));
    }

    // 5. Execute keyword search for specific quotes
    if (analysis.needsSpecificQuotes && smartKeywords.all.length > 0) {
      const keywordChunks = await this.keywordSearch(sessionId, smartKeywords.all, whereClause);
      allChunks.push(...keywordChunks);
    }
    
    // 6. Handle "about latest file" focus
    if (analysis.isAboutLatestFile) {
        const latestDoc = await sql`SELECT id FROM documents WHERE session_id = ${sessionId} ORDER BY created_at DESC LIMIT 1`;
        if (latestDoc.rows.length > 0) {
            const latestDocId = latestDoc.rows[0].id;
            const queryEmbedding = await getCachedEmbedding(message, embeddingModel);
            const latestDocChunks = await sql<Chunk>`
                SELECT c.content, c.page_number, c.document_id
                FROM chunks c
                WHERE c.document_id = ${latestDocId}
                ORDER BY c.embedding <=> ${JSON.stringify(queryEmbedding)}::vector
                LIMIT 3
            `;
            allChunks.push(...latestDocChunks.rows);
        }
    }

    // 7. De-duplicate results
    const uniqueChunks = allChunks.filter((chunk, index, self) => 
      index === self.findIndex(c => c.content === chunk.content && c.page_number === chunk.page_number)
    );
    const retrievedChunks = uniqueChunks.slice(0, searchLimit);

    if (retrievedChunks.length === 0) {
      return { retrievedChunks: [], blueprints: [] };
    }

    // 8. Get the full blueprints for the parent documents
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