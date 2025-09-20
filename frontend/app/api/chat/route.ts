import { NextRequest } from 'next/server';
import { sql } from '@/app/lib/vercel-postgres';
import genAI from '@/app/lib/ai-provider';
import { Part } from '@google/generative-ai';
import { QueryAnalyzer } from '@/app/lib/query-analyzer';
import { DocumentSearchService } from '@/app/lib/document-search';
import { CitationService } from '@/app/lib/citation-service';
import { StreamHandler } from '@/app/lib/stream-handler';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const { message, sessionId }: { message: string; sessionId?: string } = JSON.parse(body);
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const streamHandler = new StreamHandler(controller);
        const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
        const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

        streamHandler.sendThinkingStep('Analyzing query and context...');

        // Analyze query
        const analysis = await QueryAnalyzer.analyzeQuery(message, sessionId || '', visionModel as { generateContent: (parts: unknown[]) => Promise<{ response?: { text(): string } }> });
        const intent = QueryAnalyzer.detectIntent(message);
        const specificFileName = QueryAnalyzer.getSpecificFileName(message);
        const smartKeywords = QueryAnalyzer.extractSmartKeywords(message);
        const pageNumbers = QueryAnalyzer.extractPageNumbers(message);

        const searchSteps: string[] = [];

        // Send appropriate thinking steps
        if (analysis.focusStandaloneOnly || specificFileName || intent === 'VISUAL_DESCRIPTION' || analysis.isImageSpecific || analysis.shouldPrioritizeImages) {
          const stepMsg = specificFileName 
            ? `Focusing on "${specificFileName}"...` 
            : intent === 'VISUAL_DESCRIPTION'
            ? 'Focusing on visual content...'
            : 'Focusing ONLY on the latest standalone file...';
          streamHandler.sendThinkingStep(stepMsg);
        } else if (analysis.focusRecent || analysis.isAboutLatestFile) {
          streamHandler.sendThinkingStep('Focusing on the most recently uploaded file...');
        }
        
        if (analysis.isComplex && analysis.subQueries) {
          streamHandler.sendThinkingStep('Planning multi-step search with expanded terms...');
          searchSteps.push("Planning multi-step search with expanded terms...");
          
          for (const query of analysis.subQueries) {
            const stepMsg = `Searching: "${query}"`;
            streamHandler.sendThinkingStep(stepMsg);
            searchSteps.push(stepMsg);
          }
        } else {
          streamHandler.sendThinkingStep('Searching with expanded terms...');
          searchSteps.push("Searching with expanded terms...");
        }

        // Search documents
        const { retrievedChunks, blueprints } = await DocumentSearchService.searchDocuments(
          sessionId || '', message, embeddingModel, analysis, smartKeywords, pageNumbers
        );

        if (retrievedChunks.length === 0) {
          streamHandler.sendError('No relevant documents found');
          return;
        }

        const finalStep = `Found ${retrievedChunks.length} relevant sources. Generating answer...`;
        streamHandler.sendThinkingStep(finalStep);
        searchSteps.push(finalStep);
        
        // Image reanalysis logic removed for new architecture simplicity
        
        // Build context from chunks
        let contextText = `You are a document analysis assistant. Answer based on the provided documents.

CRITICAL CITATION RULE: You MUST include [SOURCE: filename] immediately after EVERY piece of information you reference from the documents.

Examples:
- "Jack shouted 'Mother! Help!' [SOURCE: short-stories-jack-and-the-beanstalk-transcript.pdf]"
- "The revenue was $2.5 million [SOURCE: quarterly-report.pdf, Page 3]"

User Question: "${message}"

--- DOCUMENT CONTEXT ---
`;
        
        for (const chunk of retrievedChunks) {
          const sourceFile = blueprints.find(bp => bp.id === chunk.document_id)?.source_file || 'Unknown';
          contextText += `\n[FILE: ${sourceFile}] [PAGE: ${chunk.page_number}] [DOC_ID: ${chunk.document_id}]\n${chunk.content}\n`;
        }
        
        const uniqueFiles = [...new Set(blueprints.map(bp => bp.source_file))];
        contextText += `\n--- END CONTEXT ---

IMPORTANT: Use information from ALL ${uniqueFiles.length} available files (${uniqueFiles.join(', ')}) when relevant. You MUST cite from multiple sources when they contain related information. Include [SOURCE: filename] or [SOURCE: filename, Page X] after EVERY fact you reference.${analysis.needsSpecificQuotes ? ' When quoting exact text, use quotation marks and cite the source.' : ''}`;

        // Generate response
        const promptParts: Part[] = [{ text: contextText }];
        if (!('generateContent' in visionModel)) {
          throw new Error('Vision model does not support generateContent');
        }
        const finalResult = await (visionModel as { generateContent: (parts: unknown[]) => Promise<{ response?: { text(): string } }> }).generateContent(promptParts);
        const finalAnswer = finalResult?.response?.text ? finalResult.response.text() : 'Sorry, I could not generate a response.';
        
        // Extract citations and process response
        const citations = await CitationService.extractCitations(finalAnswer, retrievedChunks, blueprints);
        const processedAnswer = CitationService.processResponse(finalAnswer, citations);

        // Store conversation
        try {
          await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId || ''}, 'user', ${message})`;
          await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId || ''}, 'assistant', ${finalAnswer})`;
        } catch {}
        
        // Send final response
        streamHandler.sendFinalResponse(processedAnswer, citations, searchSteps, analysis.isComplex);
        streamHandler.close();
      } catch (error) {
        console.error('Error in chat API route:', error);
        const streamHandler = new StreamHandler(controller);
        streamHandler.sendError('Internal server error');
        streamHandler.close();
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