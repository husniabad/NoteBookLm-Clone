import { sql } from '@/app/lib/vercel-postgres';

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
    const recentFileCheck = await sql`
      SELECT id, source_file, created_at, blueprint
      FROM documents 
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC
      LIMIT 20
    `;
    
    const hasRecentFiles = recentFileCheck.rows.length > 0;
    const recentFileTypes = [...new Set(recentFileCheck.rows.map(doc => doc.blueprint?.type || 'unknown'))];
    
    const conversationHistory = await sql`
      SELECT content, role, created_at
      FROM chat_messages 
      WHERE session_id = ${sessionId}
      ORDER BY created_at DESC
      LIMIT 6
    `.catch(() => ({ rows: [] }));
    
    const recentConversation = conversationHistory.rows.length > 0 ? 
      conversationHistory.rows.reverse().map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n') : '';

    return { hasRecentFiles, recentFileTypes, recentConversation };
  }

  static async analyzeQuery(
    message: string, 
    sessionId: string, 
    visionModel: any
  ): Promise<QueryAnalysis> {
    const { hasRecentFiles, recentFileTypes, recentConversation } = await this.getConversationContext(sessionId);
    const isStandaloneQuery = /this file|this image|latest|attached/i.test(message);

    const analysisPrompt = `Analyze this query considering:
- User has ${hasRecentFiles ? `recently uploaded ${recentFileTypes.join(', ')} files` : 'no recent files'}
- Recent conversation: ${recentConversation || 'None'}

Query: "${message}"

Respond with JSON containing:
- isComplex: boolean (true if comparing topics, asking multiple questions, or needs synthesis)
- subQueries: string[] (if complex, break into 2-3 simpler search queries. Include synonyms and related terms)
- focusRecent: boolean (true if query uses words like "this image", "this file", "this document", "the image", "what is in the image", or seems to reference the most recent upload)
- isAboutLatestFile: boolean (true if asking about "the image", "this image", "what is in the image", "latest file", "attached file", "this file" when a standalone file was just uploaded)
- isImageSpecific: boolean (true if asking about visual content like "man in photo", "person in image", "what does he look like", or describing people/objects in images)
- hasEntityReference: boolean (true if using pronouns like "he", "him", "that man", "the person" that likely refer to someone mentioned in recent conversation)
- shouldPrioritizeImages: boolean (true if this query should prioritize image results over text, considering both direct image queries and entity references)
- isFollowUp: boolean (true if this seems to be a follow-up question about something mentioned in recent conversation)
- expandedTerms: string[] (list of synonyms and related terms for the main query terms)
- needsSpecificQuotes: boolean (true if asking for specific quotes, exact text, or "what does it say about")
- isAnalysisQuery: boolean (true if analyzing multiple documents or comparing content)`;

    let analysis: QueryAnalysis;
    if (!('generateContent' in visionModel)) {
      analysis = { isComplex: false };
    } else {
      const analysisResult = await (visionModel as { generateContent: (parts: unknown[]) => Promise<{ response?: { text(): string } }> }).generateContent([analysisPrompt]);
      try {
        analysis = analysisResult?.response?.text ? JSON.parse(analysisResult.response.text()) : { isComplex: false };
      } catch {
        analysis = { isComplex: false };
      }
    }
    
    analysis.focusStandaloneOnly = isStandaloneQuery;
    return analysis;
  }

  static getSpecificFileName(message: string): string | null {
    const fileNamePattern = /what is in ([^?]+)/i;
    const fileNameMatch = message.match(fileNamePattern);
    return fileNameMatch ? fileNameMatch[1].trim() : null;
  }
}