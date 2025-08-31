import { NextRequest, NextResponse } from 'next/server';
import { Part, GenerateContentResponse } from '@google/generative-ai';
import { GoogleGenerativeAIStream, StreamingTextResponse } from 'ai';
import { sql } from '@/app/lib/vercel-postgres';
import genAI from '@/app/lib/ai-provider';
import { getCachedEmbedding, setCachedEmbedding } from '@/app/lib/query-cache';

export const runtime = 'edge';

interface Document {
  content: string;
  type: 'text';
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function POST(req: NextRequest) {
  try {

    const { messages, sessionId }: { messages: ChatMessage[], sessionId: string } = await req.json();

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
    }
    if (!sessionId) {
        return NextResponse.json({ error: 'No session ID provided' }, { status: 400 });
    }

    const userQuery = messages[messages.length - 1].content;
    

    let embedding = getCachedEmbedding(userQuery);
    if (!embedding) {
      const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
      if (!embeddingModel.embedContent) {
        throw new Error('Embedding model does not support embedContent');
      }
      const embeddingResult = await embeddingModel.embedContent(userQuery);
      embedding = embeddingResult.embedding.values;
      setCachedEmbedding(userQuery, embedding as number[]);
    }

    if (!embedding) {
        return NextResponse.json({ error: 'Failed to create embedding' }, { status: 500 });
    }


    const similarDocs = await sql<Document>`
      SELECT content, type
      FROM documents
      WHERE session_id = ${sessionId}
      ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector
      LIMIT 5
    `;

    const systemInstruction = "You are a helpful assistant. Answer questions naturally and directly. Use conversation history to understand context and references. Be concise and avoid phrases like 'based on the context' or 'according to the information provided' unless absolutely necessary.";
    
    // Build weighted conversation history
    const recentMessages = messages.slice(-6); // Last 6 messages (3 exchanges)
    let conversationHistory = "";
    if (recentMessages.length > 1) {
      conversationHistory = "\n--- CONVERSATION HISTORY (Most Recent First) ---\n";
      
      const pairs = [];
      for (let i = 0; i < recentMessages.length - 1; i += 2) {
        if (recentMessages[i + 1]) {
          pairs.push([recentMessages[i], recentMessages[i + 1]]);
        }
      }
      
      // Reverse to show most recent first, add priority labels
      pairs.reverse().forEach((pair, index) => {
        const priority = index === 0 ? "[MOST RECENT - HIGH PRIORITY]" : 
                        index === 1 ? "[RECENT - MEDIUM PRIORITY]" : 
                        "[OLDER - LOW PRIORITY]";
        
        conversationHistory += `${priority}\n`;
        conversationHistory += `USER: ${pair[0].content}\n`;
        conversationHistory += `ASSISTANT: ${pair[1].content}\n\n`;
      });
      
      conversationHistory += "--- END CONVERSATION HISTORY ---\n";
    }
    
    const promptParts: Part[] = [
      { text: `${systemInstruction}${conversationHistory}\n\nCurrent question: "${userQuery}"\n\n--- DOCUMENT CONTEXT ---` },
    ];

    for (const doc of similarDocs.rows) {
      promptParts.push({ text: `\n${doc.content}\n` });
    }
    promptParts.push({ text: "\n--- END CONTEXT ---" });

    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
    if (!visionModel.generateContentStream) {
      throw new Error('Vision model does not support generateContentStream');
    }
    const result = await visionModel.generateContentStream({ contents: [{ role: 'user', parts: promptParts }] });

    const stream = GoogleGenerativeAIStream(result as { stream: AsyncIterable<GenerateContentResponse> });
    return new StreamingTextResponse(stream);

  } catch (error) {
    console.error('Error in chat API route:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Internal server error', details: errorMessage }, { status: 500 });
  }
}