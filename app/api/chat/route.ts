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
        
        // Simple pattern matching for standalone file queries
        const standalonePatterns = ['this file', 'this image', 'what is in this', 'what is i this', 'latest image', 'attached file', 'what is in', 'content of'];
        const isStandaloneQuery = standalonePatterns.some(pattern => message.toLowerCase().includes(pattern));
        
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
        
        if (analysis.focusStandaloneOnly || specificFileName || message.toLowerCase().includes('image')) {
          const stepMsg = specificFileName 
            ? `Focusing on "${specificFileName}"...` 
            : message.toLowerCase().includes('image') 
            ? 'Focusing on the uploaded image...'
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
              SELECT id, content, type, url, created_at, source_file, page_number
              FROM documents 
              WHERE session_id = ${sessionId} AND is_standalone_file = TRUE
              ORDER BY created_at DESC
              LIMIT 1
            ` : (analysis.focusRecent || analysis.isAboutLatestFile) ? await sql<Document>`
              SELECT id, content, type, url, created_at, source_file, page_number
              FROM documents 
              WHERE session_id = ${sessionId}
              ORDER BY created_at DESC, embedding <=> ${JSON.stringify(embedding)}::vector 
              LIMIT ${searchLimit / analysis.subQueries.length}
            ` : await sql<Document>`
              SELECT id, content, type, url, created_at, source_file, page_number
              FROM documents 
              WHERE session_id = ${sessionId}
              ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector 
              LIMIT ${searchLimit / analysis.subQueries.length}
            `;
            contextDocs.push(...searchResult.rows);
          }
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: 'Searching with expanded terms...' })}\n\n`));
          searchSteps.push("Searching with expanded terms...");
          
          if (analysis.focusStandaloneOnly) {
            // Get only the single most recent file for "this file" queries
            const searchResult = await sql<Document>`
              SELECT id, content, type, url, created_at, source_file, page_number
              FROM documents 
              WHERE session_id = ${sessionId}
              ORDER BY created_at DESC
              LIMIT 1
            `;
            contextDocs = searchResult.rows;
          } else if (specificFileName || message.toLowerCase().includes('image')) {
            // Get recent documents for specific file or image queries
            const searchResult = await sql<Document>`
              SELECT id, content, type, url, created_at, source_file, page_number
              FROM documents 
              WHERE session_id = ${sessionId}
              ORDER BY created_at DESC
              LIMIT 5
            `;
            contextDocs = searchResult.rows;
          } else {
            // Search with multiple terms to get broader results
            const allResults: Document[] = [];
            for (const term of searchTerms.slice(0, 3)) { // Limit to 3 terms to avoid too many queries
              if (!embeddingModel.embedContent) {
                throw new Error('Embedding model does not support embedContent');
              }
              const embedding = await getCachedEmbedding(term, embeddingModel);
              const searchResult = (analysis.focusRecent || analysis.isAboutLatestFile) ? await sql<Document>`
                SELECT id, content, type, url, created_at, source_file, page_number
                FROM documents 
                WHERE session_id = ${sessionId}
                ORDER BY created_at DESC, embedding <=> ${JSON.stringify(embedding)}::vector 
                LIMIT ${Math.ceil(searchLimit / searchTerms.length)}
              ` : await sql<Document>`
                SELECT id, content, type, url, created_at, source_file, page_number
                FROM documents 
                WHERE session_id = ${sessionId}
                ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector 
                LIMIT ${Math.ceil(searchLimit / searchTerms.length)}
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

        const finalStep = `Found ${contextDocs.length} relevant sources. Generating answer...`;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: finalStep })}\n\n`));
        searchSteps.push(finalStep);

        // Sort all context docs by creation time (newest first)
        const sortedDocs = contextDocs.sort((a, b) => {
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
        
        contextText += `\n--- END CONTEXT ---

Answer the question using the documents above. Remember: Include [SOURCE: filename] or [SOURCE: filename, Page X] after EVERY fact you reference.${analysis.needsSpecificQuotes ? ' When quoting exact text, use quotation marks and cite the source.' : ''}`;

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
            
            citations.push({
              source_file: sourceFile,
              page_number: sourceDoc.page_number || pageNumber,
              content_snippet: contextSnippet,
              blob_url: sourceDoc.url,
              chunk_id: sourceDoc.id,
              specific_content: sourceDoc.content,
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
        processedAnswer = processedAnswer.replace(replacementPattern, (sourceInfo: string) => {
          const parts = sourceInfo.split(', ');
          const sourceFile = parts[0];
          const sourceNumber = sourceMap.get(sourceFile) || 1;
          const instanceId = citationInstanceCounter++;
          return `<sup data-citation-instance="${instanceId}">[${sourceNumber}]</sup>`;
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