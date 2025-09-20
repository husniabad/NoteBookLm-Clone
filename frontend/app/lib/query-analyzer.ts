import { sql } from '@/app/lib/vercel-postgres';

interface VisionModel {
  generateContent(parts: unknown[]): Promise<{ response?: { text(): string } }>;
}

export interface QueryAnalysis {
  isComplex: boolean;
  subQueries?: string[];
  focusRecent?: boolean;
  isAboutLatestFile?: boolean;
  isImageSpecific?: boolean;
  hasEntityReference?: boolean;
  shouldPrioritizeImages?: boolean;
  isFollowUp?: boolean;
  expandedTerms?: string[];
  needsSpecificQuotes?: boolean;
  isAnalysisQuery?: boolean;
  focusStandaloneOnly?: boolean;
}

export interface SmartKeywords {
  entities: string[];
  numbers: string[];
  concepts: string[];
  all: string[];
}

export class QueryAnalyzer {
  private static queryIntents = {
    SPECIFIC_CONTENT: /what (is|does it say|says) (in|on|about)|content of|what's in/i,
    VISUAL_DESCRIPTION: /describe|show|picture|image|looks like|appears|visual/i,
    FACTUAL_LOOKUP: /who|what|when|where|how much|how many|which/i,
    COMPARISON: /compare|difference|versus|vs|between|similar/i,
    SUMMARY: /summarize|overview|main points|key|summary/i,
    FOLLOW_UP: /he|she|it|that|this|they/i
  };

  static detectIntent(query: string): string {
    for (const [intent, pattern] of Object.entries(this.queryIntents)) {
      if (pattern.test(query)) return intent;
    }
    return 'GENERAL';
  }

  static extractSmartKeywords(query: string): SmartKeywords {
    const entities = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
    const numbers = query.match(/\b\d+(?:\.\d+)?\b/g) || [];
    const concepts = query.match(/\b\w{4,}\b/g) || [];
    return { entities, numbers, concepts, all: [...entities, ...numbers, ...concepts] };
  }

  static async getConversationContext(sessionId: string) {
    // Get recent chat history
    const conversationHistory = await sql`
      SELECT content, role
      FROM chat_messages 
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC
      LIMIT 6
    `.catch(() => ({ rows: [] }));

    const recentConversation = conversationHistory.rows.length > 0 
      ? conversationHistory.rows.reverse().map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n') 
      : '';
    
    const lastAssistantMessage = conversationHistory.rows.length > 0 && conversationHistory.rows[0].role === 'assistant'
      ? conversationHistory.rows[0].content
      : '';

    // Get info about the most recently uploaded document
    const recentFile = await sql`
      SELECT id, source_file, blueprint
      FROM documents 
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    let recentFileContent = '';
    if (recentFile.rows.length > 0) {
      const recentDoc = recentFile.rows[0];
      const chunks = await sql`
        SELECT content FROM chunks WHERE document_id = ${recentDoc.id} LIMIT 3
      `;
      recentFileContent = `The user most recently uploaded '${recentDoc.source_file}'. The first few chunks are:\n` +
        chunks.rows.map(c => c.content).join('\n---\n');
    }

    return { recentConversation, lastAssistantMessage, recentFileContent };
  }

  static async analyzeQuery(
    message: string, 
    sessionId: string, 
    visionModel: VisionModel
  ): Promise<QueryAnalysis> {
    const { recentConversation, lastAssistantMessage, recentFileContent } = await this.getConversationContext(sessionId);
    const isStandaloneQuery = /this file|this image|latest|attached/i.test(message);

    const analysisPrompt = `You are an expert query analyzer. Your goal is to understand the user's intent and provide a structured JSON output to guide a document retrieval system. Analyze the user's query based on the provided context.

-- CONTEXT --

[RECENT CONVERSATION]:
${recentConversation || 'None'}

[LAST ASSISTANT RESPONSE]:
${lastAssistantMessage || 'None'}

[RECENT FILE CONTEXT]:
${recentFileContent || 'None'}

-- USER QUERY --
"${message}"

-- ANALYSIS --
Analyze the query and respond with a JSON object containing these fields:
- isComplex: boolean (true if comparing topics, asking multiple questions, or needs synthesis from multiple sources)
- subQueries: string[] (if complex, break the main query into 2-3 simpler, self-contained search queries. These should be optimized for vector search.)
- focusRecent: boolean (true if the query seems to reference the most recent upload, using terms like "this file", "this document", etc.)
- isAboutLatestFile: boolean (true if asking specifically about the "latest file", "attached file", etc.)
- isImageSpecific: boolean (true if asking about visual content like "what does the person look like")
- hasEntityReference: boolean (true if using pronouns like "he", "him", "that" that likely refer to something in the conversation or documents)
- shouldPrioritizeImages: boolean (true if the query should prioritize image results)
- isFollowUp: boolean (true if this is a direct follow-up to the last assistant response)
- expandedTerms: string[] (list of synonyms or related terms for the main query concepts)
- needsSpecificQuotes: boolean (true if asking for exact text, like "what does it say about...")
- isAnalysisQuery: boolean (true if the query is for analyzing multiple documents or comparing content)
`;

    let analysis: QueryAnalysis;
    try {
      const analysisResult = await visionModel.generateContent([analysisPrompt]);
      const jsonResponse = analysisResult.response?.text() || '{}';
      analysis = JSON.parse(jsonResponse.replace(/```json\n|```/g, '').trim());
    } catch {
      analysis = { isComplex: false }; // Fallback on error
    }
    
    analysis.focusStandaloneOnly = isStandaloneQuery;
    return analysis;
  }

  static getSpecificFileName(message: string): string | null {
    const fileNamePattern = /what is in ([^?]+)/i;
    const fileNameMatch = message.match(fileNamePattern);
    return fileNameMatch ? fileNameMatch[1].trim() : null;
  }

  static extractPageNumbers(message: string): number[] {
    const pageNumbers: number[] = [];
    // Regex to find numbers after "page", "pages", "p.", etc.
    const regex = /(?:pages?|p[g.]?|on page)\s+((?:\d+\s*(?:,|\s+and\s+|&\s+)?\s*)+)/gi;
    let match;
    while ((match = regex.exec(message)) !== null) {
      const numberString = match[1];
      // Split by common delimiters and parse numbers
      const numbers = numberString.split(/(?:,|\s+and\s+|&\s+)/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => parseInt(s, 10));
      
      for (const num of numbers) {
        if (!isNaN(num) && !pageNumbers.includes(num)) {
          pageNumbers.push(num);
        }
      }
    }
    return pageNumbers;
  }
}
