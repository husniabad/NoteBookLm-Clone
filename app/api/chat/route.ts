import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { GoogleGenerativeAIStream, StreamingTextResponse } from 'ai';
import { sql } from '@/app/lib/vercel-postgres';
import genAI from '@/app/lib/gemini';

export const runtime = 'edge';

interface Document {
  content: string;
  type: 'text' | 'image';
  url: string;
}

export async function POST(req: NextRequest) {
  try {
    // CHANGE: Receive the session ID along with the messages
    const { messages, sessionId }: { messages: any[], sessionId: string } = await req.json();

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
    }
    if (!sessionId) {
        return NextResponse.json({ error: 'No session ID provided' }, { status: 400 });
    }

    const userQuery = messages[messages.length - 1].content;
    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const embeddingResult = await embeddingModel.embedContent(userQuery);
    const embedding = embeddingResult.embedding.values;

    if (!embedding) {
        return NextResponse.json({ error: 'Failed to create embedding' }, { status: 500 });
    }

    // CHANGE: Add a WHERE clause to filter the search by session ID
    const similarDocs = await sql<Document>`
      SELECT content, type, url
      FROM documents
      WHERE session_id = ${sessionId}
      ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector
      LIMIT 10
    `;

    const systemInstruction = "You are a helpful assistant. Answer the user's question based only on the provided context. If the context doesn't contain the answer, state that you don't have enough information.";
    
    const promptParts: Part[] = [
      { text: `${systemInstruction}\n\nUser query: "${userQuery}"\n\n--- CONTEXT ---` },
    ];

    for (const doc of similarDocs.rows) {
      if (doc.type === 'text') {
        promptParts.push({ text: `\nText context: "${doc.content}"\n` });
      } else if (doc.type === 'image' && doc.url) {
        try {
          const response = await fetch(doc.url);
          if (!response.ok) continue;
          const mimeType = response.headers.get('content-type');
          if (!mimeType?.startsWith('image/')) continue;
          const imageBuffer = await response.arrayBuffer();
          const imageBase64 = Buffer.from(imageBuffer).toString('base64');
          promptParts.push(
            { text: `\nImage context (from a document):\n`},
            { inlineData: { data: imageBase64, mimeType } }
          );
        } catch (error) { console.error(`Error processing image from ${doc.url}:`, error); }
      }
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