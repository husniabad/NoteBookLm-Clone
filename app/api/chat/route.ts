import { NextRequest } from 'next/server';
import { sql } from '@/app/lib/vercel-postgres';
import genAI from '@/app/lib/ai-provider';
import { getCachedEmbedding } from '@/app/lib/query-cache';
import { Part } from '@google/generative-ai';

interface Document {
  content: string;
  type: 'text' | 'image';
  url?: string;
  created_at?: string;
  source_file?: string;
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
          SELECT content, type, created_at
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
        const standalonePatterns = ['this file', 'this image', 'what is in this', 'what is i this', 'latest image', 'attached file'];
        const isStandaloneQuery = standalonePatterns.some(pattern => message.toLowerCase().includes(pattern));
        
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
- expandedTerms: string[] (list of synonyms and related terms for the main query terms)`;

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
        
        if (analysis.focusStandaloneOnly) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step: 'Focusing ONLY on the latest standalone file...' })}\n\n`));
          searchLimit = 1; // Only the latest file
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
              SELECT content, type, url, created_at, source_file
              FROM documents 
              WHERE session_id = ${sessionId} AND is_standalone_file = TRUE
              ORDER BY created_at DESC
              LIMIT 1
            ` : (analysis.focusRecent || analysis.isAboutLatestFile) ? await sql<Document>`
              SELECT content, type, url, created_at, source_file
              FROM documents 
              WHERE session_id = ${sessionId}
              ORDER BY created_at DESC, embedding <=> ${JSON.stringify(embedding)}::vector 
              LIMIT ${searchLimit / analysis.subQueries.length}
            ` : await sql<Document>`
              SELECT content, type, url, created_at, source_file
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
            // For standalone files, just get the latest one without any embedding search
            const searchResult = await sql<Document>`
              SELECT content, type, url, created_at, source_file
              FROM documents 
              WHERE session_id = ${sessionId} AND is_standalone_file = TRUE
              ORDER BY created_at DESC
              LIMIT 1
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
                SELECT content, type, url, created_at, source_file
                FROM documents 
                WHERE session_id = ${sessionId}
                ORDER BY created_at DESC, embedding <=> ${JSON.stringify(embedding)}::vector 
                LIMIT ${Math.ceil(searchLimit / searchTerms.length)}
              ` : await sql<Document>`
                SELECT content, type, url, created_at, source_file
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

        // Build enhanced context for final answer
        const systemInstruction = `You are a document analysis assistant. Answer based on the provided documents, but you can use basic common knowledge for obvious inferences. Rules:
1. Answer based on what's in the uploaded documents
2. Use basic common knowledge for clear inferences (e.g., Bangalore is in India, phone numbers indicate countries)
3. If user asks about something using different terms, find the closest match in documents
4. If information isn't in documents and can't be reasonably inferred, say "This information is not found in your uploaded documents"
5. Be helpful with obvious connections and basic geographical/factual knowledge`;
        
        const conversationContext = recentConversation ? `\n--- RECENT CONVERSATION ---\n${recentConversation}\n--- END CONVERSATION ---` : '';
        
        const contextSummary = analysis.focusRecent ? 
          `\n--- RECENT FILE CONTEXT (prioritized) ---` : 
          `\n--- DOCUMENT CONTEXT ---`;
          
        const promptParts: Part[] = [
          { text: `${systemInstruction}${conversationContext}\n\nUser Question: "${message}"${contextSummary}` }
        ];

        // Sort all context docs by creation time (newest first)
        const sortedDocs = contextDocs.sort((a, b) => {
          if (!a.created_at || !b.created_at) return 0;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
        
        // If asking about latest standalone file, use only that file's content
        let orderedDocs;
        if (analysis.focusStandaloneOnly) {
          // Use only the single most recent document (should be exactly 1)
          orderedDocs = contextDocs;
        } else if (analysis.isAboutLatestFile) {
          // Take only the top 3 newest documents
          orderedDocs = sortedDocs.slice(0, 3);
        } else if (analysis.focusRecent) {
          // Prioritize newer docs but include older ones
          orderedDocs = sortedDocs;
        } else {
          orderedDocs = contextDocs;
        }
        
        for (const doc of orderedDocs) {
          if (doc.type === 'image') {
            promptParts.push({ text: `\n[IMAGE] ${doc.content}` });
          } else {
            promptParts.push({ text: `\n[TEXT] ${doc.content}` });
          }
        }
        
        let responseGuidance;
        if (analysis.isFollowUp && recentConversation) {
          responseGuidance = "\n--- END CONTEXT ---\n\nAnswer based on the documents above. You can make basic common sense inferences (e.g., Bangalore is in India). Be helpful with obvious connections.";
        } else if (analysis.focusStandaloneOnly) {
          responseGuidance = "\n--- END CONTEXT ---\n\nSTRICT: Answer ONLY about the single file shown above. Do NOT mention any other documents, addresses, or previous content. Focus exclusively on this one file.";
        } else if (analysis.isAboutLatestFile) {
          responseGuidance = "\n--- END CONTEXT ---\n\nAnswer using document content. You can use basic common knowledge for clear inferences from the document information.";
        } else if (analysis.focusRecent) {
          responseGuidance = "\n--- END CONTEXT ---\n\nUse document content and basic common knowledge for obvious inferences. Be helpful with clear connections.";
        } else {
          responseGuidance = "\n--- END CONTEXT ---\n\nAnswer using the document content. You can make basic common sense inferences from the information provided. If truly not available, say so.";
        }
          
        promptParts.push({ text: responseGuidance });

        if (!visionModel.generateContent) {
          throw new Error('Vision model does not support generateContent');
        }
        const finalResult = await visionModel.generateContent(promptParts);
        const finalAnswer = finalResult?.response?.text ? finalResult.response.text() : 'Sorry, I could not generate a response.';

        // Store conversation messages
        try {
          await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId}, 'user', ${message})`;
          await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId}, 'assistant', ${finalAnswer})`;
        } catch {
          console.log('Note: Could not store chat messages (table may not exist)');
        }

        // Send final response
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
          type: 'response', 
          response: finalAnswer,
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