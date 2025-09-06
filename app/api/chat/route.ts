import { NextRequest } from 'next/server';
import { sql } from '@/app/lib/vercel-postgres';
import genAI from '@/app/lib/ai-provider';
import { getCachedEmbedding } from '@/app/lib/query-cache';
import { Part } from '@google/generative-ai';


interface Document {
  id: number;
  content: string;
  type: 'text' | 'image';
  url?: string;
  created_at?: string;
  source_file?: string;
  page_number?: number;
  content_type?: string;
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const { message, sessionId }: { message: string; sessionId?: string } = JSON.parse(body);
  
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {

        const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
        const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

        // Send initial thinking step
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: 'Analyzing query and context...' })}\n\n`));

        // Get recent conversation context
        const recentFileCheck = await sql`
          SELECT id, content, type, created_at, source_file, page_number, url
          FROM documents 
          WHERE session_id = ${sessionId}
          ORDER BY created_at DESC
          LIMIT 20
        `;
        
        const hasRecentFiles = recentFileCheck.rows.length > 0;
        const recentFileTypes = [...new Set(recentFileCheck.rows.map(doc => doc.type))];
        
        // Get conversation history for context
        const conversationHistory = await sql`
          SELECT content, role, created_at
          FROM chat_messages 
          WHERE session_id = ${sessionId}
          ORDER BY created_at DESC
          LIMIT 6
        `.catch(() => ({ rows: [] })); // Fallback if table doesn't exist
        
        const recentConversation = conversationHistory.rows.length > 0 ? 
          conversationHistory.rows.reverse().map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n') : '';
        
        // Smart intent recognition
        const queryIntents = {
          SPECIFIC_CONTENT: /what (is|does it say|says) (in|on|about)|content of|what's in/i,
          VISUAL_DESCRIPTION: /describe|show|picture|image|looks like|appears|visual/i,
          FACTUAL_LOOKUP: /who|what|when|where|how much|how many|which/i,
          COMPARISON: /compare|difference|versus|vs|between|similar/i,
          SUMMARY: /summarize|overview|main points|key|summary/i,
          FOLLOW_UP: /he|she|it|that|this|they/i
        };
        
        const detectIntent = (query: string) => {
          for (const [intent, pattern] of Object.entries(queryIntents)) {
            if (pattern.test(query)) return intent;
          }
          return 'GENERAL';
        };
        
        const extractSmartKeywords = (query: string) => {
          const entities = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
          const numbers = query.match(/\b\d+(?:\.\d+)?\b/g) || [];
          const concepts = query.match(/\b\w{4,}\b/g) || [];
          return { entities, numbers, concepts, all: [...entities, ...numbers, ...concepts] };
        };
        
        const intent = detectIntent(message);
        const smartKeywords = extractSmartKeywords(message);
        const isStandaloneQuery = /this file|this image|latest|attached/i.test(message);
        
        // Check if asking about specific file by name
        const fileNamePattern = /what is in ([^?]+)/i;
        const fileNameMatch = message.match(fileNamePattern);
        const specificFileName = fileNameMatch ? fileNameMatch[1].trim() : null;
        
        // Analyze query complexity and context
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

        let analysis;
        if (!visionModel.generateContent) {
          analysis = { isComplex: false };
        } else {
          const analysisResult = await visionModel.generateContent([analysisPrompt]);
          try {
            analysis = analysisResult?.response?.text ? JSON.parse(analysisResult.response.text()) : { isComplex: false };
          } catch {
            analysis = { isComplex: false };
          }
        }
        
        // Override with pattern matching for standalone queries
        analysis.focusStandaloneOnly = isStandaloneQuery;

        let contextDocs: Document[] = [];
        const searchSteps: string[] = [];

        // Prioritize recent files if query references them
        let searchLimit = 5;
        
        if (analysis.focusStandaloneOnly || specificFileName || intent === 'VISUAL_DESCRIPTION' || analysis.isImageSpecific || analysis.shouldPrioritizeImages) {
          const stepMsg = specificFileName 
            ? `Focusing on "${specificFileName}"...` 
            : intent === 'VISUAL_DESCRIPTION'
            ? 'Focusing on visual content...'
            : 'Focusing ONLY on the latest standalone file...';
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: stepMsg })}\n\n`));
          searchLimit = 5; // Allow more results for images
        } else if (analysis.focusRecent || analysis.isAboutLatestFile) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: 'Focusing on the most recently uploaded file...' })}\n\n`));
          searchLimit = 3; // Focus heavily on recent content
        }
        
        // Create expanded search terms including synonyms
        const searchTerms: string[] = [];
        if (analysis.expandedTerms && analysis.expandedTerms.length > 0) {
          searchTerms.push(message, ...analysis.expandedTerms);
        } else {
          searchTerms.push(message);
        }
        
        if (analysis.isComplex && analysis.subQueries) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: 'Planning multi-step search with expanded terms...' })}\n\n`));
          searchSteps.push("Planning multi-step search with expanded terms...");
          
          for (const query of analysis.subQueries) {
            const stepMsg = `Searching: "${query}"`;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: stepMsg })}\n\n`));
            searchSteps.push(stepMsg);
            
            if (!embeddingModel.embedContent) {
              throw new Error('Embedding model does not support embedContent');
            }
            const embedding = await getCachedEmbedding(query, embeddingModel);
            const searchResult = analysis.focusStandaloneOnly ? await sql<Document>`
              SELECT id, content, type, url, created_at, source_file, page_number, content_type
              FROM documents 
              WHERE session_id = ${sessionId} AND is_standalone_file = TRUE
              ORDER BY created_at DESC
              LIMIT 1
            ` : (analysis.focusRecent || analysis.isAboutLatestFile) ? await sql<Document>`
              SELECT id, content, type, url, created_at, source_file, page_number, content_type
              FROM documents 
              WHERE session_id = ${sessionId}
              ORDER BY created_at DESC, embedding <=> ${JSON.stringify(embedding)}::vector 
              LIMIT ${Math.floor(searchLimit / analysis.subQueries.length)}
            ` : await sql<Document>`
              SELECT id, content, type, url, created_at, source_file, page_number, content_type
              FROM documents 
              WHERE session_id = ${sessionId}
              ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector 
              LIMIT ${Math.floor(searchLimit / analysis.subQueries.length)}
            `;
            contextDocs.push(...searchResult.rows);
          }
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: 'Searching with expanded terms...' })}\n\n`));
          searchSteps.push("Searching with expanded terms...");
          
          if (analysis.focusStandaloneOnly) {
            // Get only the single most recent file for "this file" queries
            const searchResult = await sql<Document>`
              SELECT id, content, type, url, created_at, source_file, page_number, content_type
              FROM documents 
              WHERE session_id = ${sessionId}
              ORDER BY created_at DESC
              LIMIT 1
            `;
            contextDocs = searchResult.rows;
          } else if (specificFileName || intent === 'VISUAL_DESCRIPTION' || analysis.isImageSpecific || analysis.shouldPrioritizeImages) {
            // First try keyword matching for specific terms
            const keywords = message.toLowerCase().match(/\b\w{4,}\b/g) || [];
            if (keywords.length > 0) {
              const allKeywordResults: Document[] = [];
              for (const keyword of keywords.slice(0, 3)) {
                const result = await sql<Document>`
                  SELECT id, content, type, url, created_at, source_file, page_number, content_type
                  FROM documents 
                  WHERE session_id = ${sessionId} 
                    AND LOWER(content) LIKE ${`%${keyword}%`}
                  ORDER BY created_at DESC
                  LIMIT 2
                `;
                allKeywordResults.push(...result.rows);
              }
              
              if (allKeywordResults.length > 0) {
                contextDocs = allKeywordResults.slice(0, 5);
              } else {
                // Fallback to recent documents
                const searchResult = await sql<Document>`
                  SELECT id, content, type, url, created_at, source_file, page_number, content_type
                  FROM documents 
                  WHERE session_id = ${sessionId}
                  ORDER BY created_at DESC
                  LIMIT 5
                `;
                contextDocs = searchResult.rows;
              }
            } else {
              const searchResult = await sql<Document>`
                SELECT id, content, type, url, created_at, source_file, page_number, content_type
                FROM documents 
                WHERE session_id = ${sessionId}
                ORDER BY created_at DESC
                LIMIT 5
              `;
              contextDocs = searchResult.rows;
            }
          } else {
            // Smart search based on intent and keywords
            const calculateRelevanceScore = (doc: Document & { content_type?: string }, keywords: { all: string[]; entities: string[] }, intent: string) => {
              const content = doc.content.toLowerCase();
              let score = 0;
              
              // Intent-content type matching
              if (intent === 'VISUAL_DESCRIPTION' && doc.content_type === 'analysis') score += 50;
              if (intent === 'FACTUAL_LOOKUP' && doc.content_type === 'table') score += 40;
              if (intent === 'SPECIFIC_CONTENT' && doc.content_type === 'text') score += 30;
              
              // Keyword scoring with position weighting
              for (const keyword of keywords.all) {
                const keywordLower = keyword.toLowerCase();
                if (content.includes(keywordLower)) {
                  const firstIndex = content.indexOf(keywordLower);
                  score += keyword.length * 2;
                  // Early appearance bonus
                  if (firstIndex < 100) score += 10;
                  // Entity bonus
                  if (keywords.entities.includes(keyword)) score += 15;
                }
              }
              
              return score;
            };
            
            let keywordResults: { rows: (Document & { score: number })[] } = { rows: [] };
            if (smartKeywords.all.length > 0) {
              const allDocs = await sql<Document>`
                SELECT id, content, type, url, created_at, source_file, page_number, content_type
                FROM documents 
                WHERE session_id = ${sessionId}
                ORDER BY created_at DESC
              `;
              
              const scoredDocs = allDocs.rows.map(doc => ({
                ...doc,
                score: calculateRelevanceScore(doc, smartKeywords, intent)
              })).filter(doc => doc.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);
              
              keywordResults = { rows: scoredDocs };
            }
            
            // If keyword search finds results, use them; otherwise fall back to semantic search
            if (keywordResults.rows.length > 0) {
              contextDocs = keywordResults.rows;
            } else {
              // Search with multiple terms to get broader results
              const allResults: Document[] = [];
              for (const term of searchTerms.slice(0, 3)) { // Limit to 3 terms to avoid too many queries
                if (!embeddingModel.embedContent) {
                  throw new Error('Embedding model does not support embedContent');
                }
                const embedding = await getCachedEmbedding(term, embeddingModel);
                const searchResult = (analysis.focusRecent || analysis.isAboutLatestFile || intent === 'VISUAL_DESCRIPTION' || analysis.isImageSpecific || analysis.shouldPrioritizeImages) ? await sql<Document>`
                  SELECT id, content, type, url, created_at, source_file, page_number, content_type
                  FROM documents 
                  WHERE session_id = ${sessionId}
                  ORDER BY CASE WHEN type = 'image' THEN 0 ELSE 1 END, created_at DESC, embedding <=> ${JSON.stringify(embedding)}::vector 
                  LIMIT ${Math.floor(searchLimit / searchTerms.length)}
                ` : await sql<Document>`
                  SELECT id, content, type, url, created_at, source_file, page_number, content_type
                  FROM documents 
                  WHERE session_id = ${sessionId}
                  ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector 
                  LIMIT ${Math.floor(searchLimit / searchTerms.length)}
                `;
                allResults.push(...searchResult.rows);
              }
              
              // Remove duplicates and limit results
              const uniqueResults = allResults.filter((doc, index, self) => 
                index === self.findIndex(d => d.content === doc.content)
              );
              contextDocs = uniqueResults.slice(0, searchLimit);
            }
          }
        }

        const finalStep = `Found ${contextDocs.length} relevant sources. Generating answer...`;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: finalStep })}\n\n`));
        searchSteps.push(finalStep);
        
        // Check if we need to re-analyze images for more detail
        const imageDoc = contextDocs.find(doc => doc.type === 'image');
        const needsImageReanalysis = (intent === 'VISUAL_DESCRIPTION' || analysis.isImageSpecific || analysis.shouldPrioritizeImages) && 
                                   imageDoc && imageDoc.url;
        
        if (needsImageReanalysis) {
          // Analyze if current description has enough detail for the query
          const adequacyPrompt = `User Query: "${message}"
Current Image Description: "${imageDoc.content}"

Analyze if the current description provides enough detail to answer the user's query. Consider:
- Does it address the main aspects the user is asking about?
- Are there missing visual details that would help answer the query?
- Is the description comprehensive enough?

Respond with JSON: {"adequate": boolean, "missingAspects": ["aspect1", "aspect2"], "confidence": 0-100}`;

          if (!visionModel.generateContent) {
            throw new Error('Vision model does not support generateContent');
          }
          const adequacyResult = await visionModel.generateContent([adequacyPrompt]);
          let adequacyAnalysis;
          try {
            adequacyAnalysis = JSON.parse(adequacyResult?.response?.text() || '{"adequate": true}');
          } catch {
            adequacyAnalysis = { adequate: true };
          }
          
          if (!adequacyAnalysis.adequate && adequacyAnalysis.confidence < 50) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: 'Re-analyzing image for additional details...' })}\n\n`));
            
            // Construct focused prompt for missing details
            const missingAspects = adequacyAnalysis.missingAspects || [];
            const focusedPrompt = `Re-analyze this image focusing specifically on: ${missingAspects.join(', ')}. 
User is asking: "${message}"
Provide detailed description of these specific aspects that were not covered in the previous analysis.`;
            
            try {
              if (!imageDoc.url) {
                throw new Error('Image URL not available');
              }
              const imageResponse = await fetch(imageDoc.url);
              const imageBuffer = await imageResponse.arrayBuffer();
              const imagePart: Part = { inlineData: { data: Buffer.from(imageBuffer).toString('base64'), mimeType: 'image/jpeg' } };
              
              const reanalysisResult = await visionModel.generateContent([focusedPrompt, imagePart]);
              const additionalDetails = reanalysisResult?.response?.text() || '';
              
              if (additionalDetails) {
                // Add the additional details to context
                contextDocs.push({
                  id: imageDoc.id + 1000, // Unique ID
                  content: additionalDetails,
                  type: 'image',
                  url: imageDoc.url,
                  source_file: imageDoc.source_file,
                  page_number: imageDoc.page_number
                });
                
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: 'Enhanced image analysis complete. Generating detailed answer...' })}\n\n`));
              }
            } catch (error) {
              console.error('Re-analysis failed:', error);
            }
          }
        }

        // Sort all context docs by creation time (newest first), but keep re-analysis results at the end
        const sortedDocs = contextDocs.sort((a, b) => {
          // Keep re-analysis results (high ID) at the end
          if (a.id > 1000 && b.id <= 1000) return 1;
          if (b.id > 1000 && a.id <= 1000) return -1;
          
          if (!a.created_at || !b.created_at) return 0;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
        
        // If asking about latest standalone file, use only that file's content
        let orderedDocs;
        if (analysis.focusStandaloneOnly) {
          orderedDocs = contextDocs;
        } else if (analysis.isAboutLatestFile) {
          orderedDocs = sortedDocs.slice(0, 3);
        } else if (analysis.focusRecent) {
          orderedDocs = sortedDocs;
        } else {
          orderedDocs = contextDocs;
        }
        
        // Build context with document IDs for citation tracking
        let contextText = `You are a document analysis assistant. Answer based on the provided documents.

CRITICAL CITATION RULE: You MUST include [SOURCE: filename] immediately after EVERY piece of information you reference from the documents.

Examples:
- "Jack shouted 'Mother! Help!' [SOURCE: short-stories-jack-and-the-beanstalk-transcript.pdf]"
- "The revenue was $2.5 million [SOURCE: quarterly-report.pdf, Page 3]"

User Question: "${message}"

--- DOCUMENT CONTEXT ---
`;
        
        for (const doc of orderedDocs) {
          contextText += `\n[FILE: ${doc.source_file}] [PAGE: ${doc.page_number || 1}] [DOC_ID: ${doc.id}]\n${doc.content}\n`;
        }
        
        const uniqueFiles = [...new Set(orderedDocs.map(doc => doc.source_file))];
        contextText += `\n--- END CONTEXT ---

IMPORTANT: Use information from ALL ${uniqueFiles.length} available files (${uniqueFiles.join(', ')}) when relevant. You MUST cite from multiple sources when they contain related information. Include [SOURCE: filename] or [SOURCE: filename, Page X] after EVERY fact you reference.${analysis.needsSpecificQuotes ? ' When quoting exact text, use quotation marks and cite the source.' : ''}`;

        // Use your existing AI provider system
        const promptParts: Part[] = [
          { text: contextText }
        ];

        if (!visionModel.generateContent) {
          throw new Error('Vision model does not support generateContent');
        }
        const finalResult = await visionModel.generateContent(promptParts);
        const finalAnswer = finalResult?.response?.text ? finalResult.response.text() : 'Sorry, I could not generate a response.';
        
        // Create citations with exact document content
        interface Citation {
          source_file: string;
          page_number?: number;
          content_snippet: string;
          blob_url?: string;
          chunk_id?: number;
          specific_content?: string;
          citation_id?: string;
          citation_index?: number;
          highlight_phrases?: string[];
          highlighted_html?: string;
        }

        const citations: Citation[] = [];
        const extractPattern = /\[SOURCE: ([^\]]+)\]/g;
        let match;
        
        while ((match = extractPattern.exec(finalAnswer)) !== null) {
          const parts = match[1].split(', ');
          const sourceFile = parts[0];
          const pageMatch = parts.find(p => p.startsWith('Page '));
          const pageNumber = pageMatch ? parseInt(pageMatch.replace('Page ', '')) : undefined;
          
          // Extract context snippet for this specific citation
          const beforeText = finalAnswer.substring(0, match.index);
          const afterText = finalAnswer.substring(match.index + match[0].length);
          
          const sentenceStart = Math.max(
            beforeText.lastIndexOf('. '),
            beforeText.lastIndexOf('\n'),
            beforeText.lastIndexOf(': '),
            Math.max(0, match.index - 200)
          );
          const sentenceEnd = Math.min(
            afterText.indexOf('. ') !== -1 ? match.index + match[0].length + afterText.indexOf('. ') + 1 : finalAnswer.length,
            afterText.indexOf('\n') !== -1 ? match.index + match[0].length + afterText.indexOf('\n') : finalAnswer.length,
            match.index + match[0].length + 200
          );
          
          let contextSnippet = finalAnswer.substring(sentenceStart, sentenceEnd)
            .replace(/\[SOURCE: [^\]]+\]/g, '')
            .trim();
          
          if (contextSnippet.length < 20) {
            contextSnippet = finalAnswer.substring(
              Math.max(0, match.index - 100),
              Math.min(finalAnswer.length, match.index + match[0].length + 100)
            ).replace(/\[SOURCE: [^\]]+\]/g, '').trim();
          }
          
          // Find the most relevant source document chunk for this specific context
          let bestSourceDoc = null;
          let bestScore = 0;
          
          // Get all docs from this source file
          const sourceDocs = orderedDocs.filter(doc => 
            doc.source_file === sourceFile && 
            (!pageNumber || doc.page_number === pageNumber)
          );
          
          
          // Find the doc chunk that best matches this citation context
          for (const doc of sourceDocs) {
            if (!doc.content) continue;
            
            const docContent = doc.content.toLowerCase();
            const contextWords = contextSnippet.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
            
            let score = 0;
            
            // Score based on exact phrase matches
            for (let len = 5; len >= 3; len--) {
              for (let i = 0; i <= contextWords.length - len; i++) {
                const phrase = contextWords.slice(i, i + len).join(' ');
                if (docContent.includes(phrase)) {
                  score += len * 15;
                }
              }
            }
            
            // Score based on individual word matches
            for (const word of contextWords) {
              if (docContent.includes(word)) {
                score += word.length * 2;
              }
            }
            
            if (score > bestScore) {
              bestScore = score;
              bestSourceDoc = doc;
            }
          }
                   
          // Use the best matching doc or fallback to first available
          const sourceDoc = bestSourceDoc || sourceDocs[0];
          
          if (!bestSourceDoc) {
          }
          
          if (sourceDoc?.url) {
            
            // Unified highlighting logic from preview API
            const CONFIG = {
              POETRY_MAX_LINE_WORDS: 12,
              PROSE_DOMINANCE_THRESHOLD: 0.80,
              PHRASE_EXTRACTION_COUNT: [3, 6],
              PHRASE_WORD_COUNT: [3, 8]
            };
            
            const analyzeTextStructure = (text: string) => {
              const lines = text.split('\n').filter(line => line.trim().length > 0);
              const totalWords = text.split(/\s+/).length;
              
              // Check for structured text (lists, indentation)
              const structuredLines = lines.filter(line => 
                /^\s*[\*\-\d+\.]\s/.test(line) || /^\s{4,}/.test(line)
              );
              if (structuredLines.length > lines.length * 0.3) {
                return { type: 'FULL_HIGHLIGHT', reason: 'structured_text' };
              }
              
              // Check for dialogue
              const hasQuotes = /["']/.test(text);
              const hasSpeechVerbs = /\b(said|asked|yelled|whispered|declared|announced|shouted|replied|responded)\b/i.test(text);
              if (hasQuotes && hasSpeechVerbs) {
                return { type: 'FULL_HIGHLIGHT', reason: 'dialogue' };
              }
              
              // Check for poetry
              if (lines.length > 2) {
                const shortLines = lines.filter(line => {
                  const words = line.trim().split(/\s+/).length;
                  return words <= CONFIG.POETRY_MAX_LINE_WORDS;
                });
                const hasStanzaBreaks = /\n\s*\n/.test(text);
                const hasPoetryTitle = lines[0] && lines[0].split(/\s+/).length <= 4 && !lines[0].endsWith('.');
                
                // Poetry detection: short lines OR stanza breaks OR poetry title pattern
                if (shortLines.length > lines.length * 0.5 || hasStanzaBreaks || hasPoetryTitle) {
                  return { type: 'FULL_HIGHLIGHT', reason: 'poetry' };
                }
              }
              
              // Check for long quotations
              const longQuoteMatch = text.match(/["']([^"']{100,})["']/g);
              if (longQuoteMatch) {
                return { type: 'FULL_HIGHLIGHT', reason: 'long_quote' };
              }
              
              // Check for verse-like structure (common in poetry)
              const avgWordsPerLine = totalWords / lines.length;
              const hasVerseStructure = avgWordsPerLine < 8 && lines.length > 2;
              
              if (hasVerseStructure) {
                return { type: 'FULL_HIGHLIGHT', reason: 'verse_structure' };
              }
              
              // Mixed content rule: Check prose dominance
              const proseWords = text.replace(/["'].*?["']/g, '').split(/\s+/).length;
              const proseDominance = proseWords / totalWords;
              
              if (proseDominance >= CONFIG.PROSE_DOMINANCE_THRESHOLD) {
                return { type: 'PHRASE_HIGHLIGHT', reason: 'prose_dominant' };
              }
              
              return { type: 'PHRASE_HIGHLIGHT', reason: 'regular_prose' };
            };
            
            const extractContextualPhrases = async (text: string, context: string) => {
              const aiPrompt = `Citation Context: "${context}"\n\nText Paragraph: "${text}"\n\nExtract ${CONFIG.PHRASE_EXTRACTION_COUNT[0]}-${CONFIG.PHRASE_EXTRACTION_COUNT[1]} key phrases (${CONFIG.PHRASE_WORD_COUNT[0]}-${CONFIG.PHRASE_WORD_COUNT[1]} words each) from the paragraph that are most semantically related to the citation context.\n\nFocus on:\n- Complete meaningful phrases, not individual words\n- Content that directly relates to the context\n- Important concepts, entities, or technical terms\n\nReturn phrases separated by | (pipe). Example: "urban development project|environmental impact assessment|community consultation process"`;
              
              try {
                const textModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                if (!textModel.generateContent) throw new Error('Text model generateContent not available');
                
                const aiResult = await textModel.generateContent([aiPrompt]);
                const aiResponse = aiResult?.response?.text() || '';
                const aiPhrases = aiResponse.split('|').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
                
                const validPhrases = aiPhrases.filter((phrase: string) => {
                  const wordCount = phrase.split(/\s+/).length;
                  const isValidLength = wordCount >= CONFIG.PHRASE_WORD_COUNT[0] && wordCount <= CONFIG.PHRASE_WORD_COUNT[1];
                  const existsInText = text.toLowerCase().includes(phrase.toLowerCase());
                  return isValidLength && existsInText && phrase.length > 10;
                });
                
                return validPhrases.slice(0, CONFIG.PHRASE_EXTRACTION_COUNT[1]);
              } catch {
                const contextWords = context.split(/\s+/).filter((w: string) => 
                  w.length > 4 && text.toLowerCase().includes(w.toLowerCase())
                );
                return contextWords.slice(0, CONFIG.PHRASE_EXTRACTION_COUNT[0]);
              }
            };
            
            const analysisResult = analyzeTextStructure(sourceDoc.content || '');
            let highlightPhrases: string[];
            
            if (analysisResult.type === 'FULL_HIGHLIGHT') {
              highlightPhrases = [(sourceDoc.content || '').trim()];
            } else {
              highlightPhrases = await extractContextualPhrases(sourceDoc.content || '', contextSnippet);
            }
            
            // Unified highlighting function for both citation and response
            const applyHighlighting = (content: string, phrases: string[]) => {
              // Check if this is full highlight (poem, dialogue, etc.) before processing
              const isFullHighlight = analysisResult.type === 'FULL_HIGHLIGHT' || 
                                    (phrases.length === 1 && phrases[0].trim().length > content.trim().length * 0.8);
              
              
              let html = content
                .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold text-foreground">$1</strong>')
                .replace(/^(\d+\.)\s/gm, '<span class="font-medium">$1</span> ')
                .replace(/^\s*-\s/gm, '• ')
                .replace(/\n/g, '<br/>');
              
              if (isFullHighlight) {
                html = `<mark class="bg-muted text-foreground font-semibold rounded px-1 py-0.5">${html}</mark>`;
              } else {
                // Sort phrases by length (longest first) to avoid partial matches
                phrases.sort((a, b) => b.length - a.length).forEach(phrase => {
                  // Use word boundaries for short phrases, no boundaries for long phrases
                  const useWordBoundaries = phrase.split(/\s+/).length <= 3;
                  const pattern = useWordBoundaries ? 
                    `\\b(${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b` :
                    `(${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`;
                  const regex = new RegExp(pattern, 'gi');
                  html = html.replace(regex, '<mark class="bg-muted text-foreground font-semibold rounded px-1 py-0.5">$1</mark>');
                });
              }
              
              return html;
            };
            
            citations.push({
              source_file: sourceFile,
              page_number: sourceDoc.page_number || pageNumber,
              content_snippet: contextSnippet,
              blob_url: sourceDoc.url,
              chunk_id: sourceDoc.id,
              specific_content: sourceDoc.content,
              highlight_phrases: highlightPhrases,
              highlighted_html: applyHighlighting(sourceDoc.content || '', highlightPhrases),
              citation_id: `${sourceDoc.id}-${Date.now()}-${Math.random()}`, // Unique ID for each citation
              citation_index: citations.length // Track the order of citations
            });
          }
        }


        // Store conversation messages
        try {
          await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId}, 'user', ${message})`;
          await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId}, 'assistant', ${finalAnswer})`;
        } catch {
        }


        
        // Process response to replace citation tags with numbers
        let processedAnswer = finalAnswer;
        const sourceMap = new Map<string, number>();
        let sourceCounter = 1;
        let citationInstanceCounter = 0;
        
        // Create source mapping and track citation instances
        citations.forEach(citation => {
          if (!sourceMap.has(citation.source_file)) {
            sourceMap.set(citation.source_file, sourceCounter++);
          }
        });
        
        // Replace [SOURCE: ...] with superscript numbers, adding instance tracking
        const replacementPattern = /\[SOURCE: ([^\]]+)\]/g;
        processedAnswer = processedAnswer.replace(replacementPattern, (fullMatch: string, sourceInfo: string) => {
          const parts = sourceInfo.split(', ');
          const sourceFile = parts[0];
          const sourceNumber = sourceMap.get(sourceFile) || 1;
          const instanceId = citationInstanceCounter++;
          return `<sup data-citation-instance="${instanceId}">[${sourceNumber}]</sup>`;
        });
        
        // Apply unified highlighting to main response
        citations.forEach((citation) => {

          if (citation.highlight_phrases && citation.highlight_phrases.length > 0) {
            citation.highlight_phrases.forEach(phrase => {
              const regex = new RegExp(`\\b(${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
              processedAnswer = processedAnswer.replace(regex, '<mark class="bg-muted text-foreground font-semibold rounded px-1 py-0.5">$1</mark>');
            });
          }
        });
        
        // Debug: Log final citations being sent
        citations.forEach(() => {
        });
        
        // Send final response with citations
        
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
          type: 'response', 
          response: processedAnswer,
          citations: citations,
          searchSteps,
          isComplex: analysis.isComplex
        })}\n\n`));
        
        controller.close();
      } catch (error) {
        console.error('Error in chat API route:', error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: 'Internal server error' })}\n\n`));
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}