import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/vercel-postgres";
import genAI from "@/app/lib/ai-provider";
import sharp from 'sharp';
import { Part } from "@google/generative-ai";
import { createSemanticChunks } from "@/app/lib/document-analyzer";
import { uploadToS3 } from "@/app/lib/s3-client";

interface PageData {
  combined_markdown: string;
  page_number: number;
}

interface ChunkData {
  content: string;
  pageNumber: number;
}

const PYTHON_BACKEND_URL = "http://127.0.0.1:8000/process-pdf/";

export async function POST(req: NextRequest) {
  try {
    const { fileBuffer: bufferArray, fileType, originalFileName, sessionId } = await req.json();
    
    const fileBuffer = Buffer.from(bufferArray);
    const file = new File([fileBuffer], originalFileName, { type: fileType });


    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

if (fileType === 'application/pdf') {

        // 1. Forward the PDF to the Python backend
        const backendFormData = new FormData();
        backendFormData.append("file", file);
        
        const pythonResponse = await fetch(PYTHON_BACKEND_URL, {
            method: "POST",
            body: backendFormData,
        });

        if (!pythonResponse.ok) {
            throw new Error(`Python backend failed with status: ${pythonResponse.status}`);
        }

        const processedData = await pythonResponse.json();
        const blueprint = processedData.data;
        const pdfUrl = processedData.pdf_url;

        // 2. Store the entire blueprint in PostgreSQL with PDF URL
        const documentResult = await sql`
            INSERT INTO documents (source_file, session_id, blueprint, pdf_url)
            VALUES (${originalFileName}, ${sessionId}, ${JSON.stringify(blueprint)}, ${pdfUrl})
            RETURNING id;
        `;
        const documentId = documentResult.rows[0].id;
        
        // 3. Chunk and embed the combined_markdown for the vector database
        const allChunks: ChunkData[] = blueprint.flatMap((page: PageData) => ({
            content: page.combined_markdown,
            pageNumber: page.page_number,
        }));

        const embeddings = await Promise.all(
            allChunks.map((chunk: ChunkData) => embeddingModel.embedContent!(chunk.content))
        );

        const insertPromises = allChunks.map((chunk: ChunkData, i: number) => 
          sql`
            INSERT INTO chunks (document_id, content, embedding, page_number)
            VALUES (${documentId}, ${chunk.content}, ${JSON.stringify(embeddings[i].embedding.values)}, ${chunk.pageNumber})
          `
        );
        await Promise.all(insertPromises);
    } 
    else if (fileType.startsWith('image/')) {
      const metadata = await sharp(fileBuffer).metadata();
      const resizedBuffer = (metadata.width && metadata.width > 1200) || (metadata.height && metadata.height > 1200)
        ? await sharp(fileBuffer).resize({ width: 1200, height: 1200, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer()
        : fileBuffer;

      // Upload to S3
      const s3Url = await uploadToS3(resizedBuffer, originalFileName, 'image/jpeg');

      const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/jpeg' } };
      if (!('generateContent' in visionModel)) {
        throw new Error('Vision model does not support generateContent');
      }
      const descriptionResult = await visionModel.generateContent(["Analyze this image comprehensively. Extract ALL text exactly as written. Describe visual elements: people (appearance, clothing, actions), objects (colors, materials, brands), setting (location, lighting, atmosphere), and any charts/data if present. Be specific and thorough.", imagePart]);
      const richDescription = descriptionResult?.response?.text?.() || '';

      // 1. Create a simple master record in 'documents'
      const documentResult = await sql`
        INSERT INTO documents (source_file, session_id, blueprint)
        VALUES (${originalFileName}, ${sessionId}, ${JSON.stringify({ type: 'image', blob_url: s3Url })})
        RETURNING id;
      `;
      const documentId = documentResult.rows[0].id;

      // 2. Insert the description as a single chunk into 'chunks'
      if (!embeddingModel.embedContent) {
        throw new Error('Embedding model does not support embedContent');
      }
      const embeddingResult = await embeddingModel.embedContent(richDescription);
      await sql`
        INSERT INTO chunks (document_id, content, embedding, page_number)
        VALUES (${documentId}, ${richDescription}, ${JSON.stringify(embeddingResult.embedding.values)}, 1);
      `;
    }
    else if (fileType.startsWith('text/')) {
        const textContent = fileBuffer.toString('utf-8');

        // Upload to S3
        const s3Url = await uploadToS3(fileBuffer, originalFileName, fileType);

        // 1. Create a simple master record in 'documents'
        const documentResult = await sql`
          INSERT INTO documents (source_file, session_id, blueprint)
          VALUES (${originalFileName}, ${sessionId}, ${JSON.stringify({ type: 'text', blob_url: s3Url })})
          RETURNING id;
        `;
        const documentId = documentResult.rows[0].id;
        
        // 2. Chunk the text and insert into 'chunks'
        // Replace this with your actual semantic chunker
        const semanticChunks = createSemanticChunks(textContent);
        
        if (!embeddingModel.embedContent) {
          throw new Error('Embedding model does not support embedContent');
        }
        
        const embeddings = await Promise.all(semanticChunks.map(chunk => embeddingModel.embedContent!(chunk.content)));
        const insertPromises = semanticChunks.map((chunk, i) => 
            sql`
                INSERT INTO chunks (document_id, content, embedding, page_number)
                VALUES (${documentId}, ${chunk.content}, ${JSON.stringify(embeddings[i].embedding.values)}, 1);
            `
        );
        await Promise.all(insertPromises);
    }

    return NextResponse.json({ success: true, message: 'Processing complete.' });
  } catch (error) {
    console.error('Error in processing job:', error);
    return NextResponse.json({ error: 'Failed to process file in background' }, { status: 500 });
  }
}