import { NextRequest, NextResponse } from 'next/server';
import { Part } from '@google/generative-ai';
import { GoogleGenerativeAIStream, StreamingTextResponse } from 'ai';
import { sql } from '@/app/lib/vercel-postgres';
import genAI from '@/app/lib/gemini';
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
      const embeddingResult = await embeddingModel.embedContent(userQuery);
      embedding = embeddingResult.embedding.values;
      setCachedEmbedding(userQuery, embedding);
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

    const systemInstruction = "You are a helpful assistant. Answer the user's question based only on the provided context. If the context doesn't contain the answer, state that you don't have enough information.";
    
    const promptParts: Part[] = [
      { text: `${systemInstruction}\n\nUser query: "${userQuery}"\n\n--- CONTEXT ---` },
    ];


    for (const doc of similarDocs.rows) {
      promptParts.push({ text: `\nContext: "${doc.content}"\n` });
    }
    promptParts.push({ text: "\n--- END OF CONTEXT ---" });

    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
    const result = await visionModel.generateContentStream({ contents: [{ role: 'user', parts: promptParts }] });

    const stream = GoogleGenerativeAIStream(result);
    return new StreamingTextResponse(stream);

  } catch (error) {
    console.error('Error in chat API route:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Internal server error', details: errorMessage }, { status: 500 });
  }
}