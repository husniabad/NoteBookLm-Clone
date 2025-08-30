import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { GoogleGenerativeAIStream, StreamingTextResponse } from 'ai';
import { sql } from '@/app/lib/vercel-postgres';
import genAI from '@/app/lib/gemini';

// Set the runtime to edge
export const runtime = 'edge';

// Define the structure of a message in the request body
interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// Define the structure of a document retrieved from the database
interface Document {
  content: string;
  type: 'text' | 'image';
  url: string;
}

// Main function to handle POST requests
export async function POST(req: NextRequest) {
  try {
    const { messages }: { messages: Message[] } = await req.json();

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: 'No messages provided' }, { status: 400 });
    }

    // Extract the last message as the user's query
    const userQuery = messages[messages.length - 1].content;

    // 1. Create a 768-dimension vector embedding for the user's query
    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const embeddingResult = await embeddingModel.embedContent(userQuery);
    const embedding = embeddingResult.embedding.values;

    if (!embedding) {
        return NextResponse.json({ error: 'Failed to create embedding' }, { status: 500 });
    }

    // 2. Execute a similarity search on the PostgreSQL database
    const similarDocs = await sql<Document>`
      SELECT content, type, url
      FROM documents
      ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector
      LIMIT 5
    `;

    // 3. Construct a multi-part prompt for the multimodal LLM
    const systemInstruction = "You are a helpful assistant. Answer the user's question based only on the provided context. If the context doesn't contain the answer, state that you don't have enough information.";
    
    const promptParts: Part[] = [
      { text: systemInstruction },
      { text: `\nUser query: "${userQuery}"\n\nContext:\n` },
    ];

    // Process the retrieved documents
    for (const doc of similarDocs.rows) {
      if (doc.type === 'text') {
        promptParts.push({ text: `Text context: "${doc.content}"\n` });
      } else if (doc.type === 'image' && doc.url) {
        try {
          // Fetch the image from its URL
          const response = await fetch(doc.url);
          if (!response.ok) {
            console.warn(`Failed to fetch image from ${doc.url}, status: ${response.status}`);
            continue; // Skip this image if fetching fails
          }
          const mimeType = response.headers.get('content-type');
          if (!mimeType || !mimeType.startsWith('image/')) {
            console.warn(`Skipping non-image content from ${doc.url}, mime-type: ${mimeType}`);
            continue;
          }
          
          // Convert the image to a base64 string
          const imageBuffer = await response.arrayBuffer();
          const imageBase64 = Buffer.from(imageBuffer).toString('base64');
          
          promptParts.push(
            { text: `Image context (from ${doc.url}):\n`},
            {
              inlineData: {
                data: imageBase64,
                mimeType,
              },
            }
          );
        } catch (error) {
          console.error(`Error processing image from ${doc.url}:`, error);
          // Continue to the next document even if one image fails
        }
      }
    }

    // 4. Call the multimodal LLM and stream its response
    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
    const result = await visionModel.generateContentStream(promptParts);

    // Create a streaming response using the Vercel AI SDK
    const stream = GoogleGenerativeAIStream(result);
 
    return new StreamingTextResponse(stream);

  } catch (error) {
    console.error('Error in chat API route:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Internal server error', details: errorMessage }, { status: 500 });
  }
}