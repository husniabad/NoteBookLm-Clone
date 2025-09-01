import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/vercel-postgres";
import genAI from "@/app/lib/ai-provider";
import { splitIntoChunks } from "@/app/lib/rag-utils";
import { put } from "@vercel/blob";
import pdf from 'pdf-parse';
import pdf2pic from 'pdf2pic';
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';
import { Part } from "@google/generative-ai";

export async function POST(req: NextRequest) {
  try {
    const { blobUrl, originalFileName, sessionId } = await req.json();

    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
    
    const fileBuffer = Buffer.from(await response.arrayBuffer());
    const fileType = response.headers.get('content-type') || '';

    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

    if (fileType === 'application/pdf') {
      // Use fast pdf-parse for all text
      const pdfData = await pdf(fileBuffer);
      const textChunks = splitIntoChunks(pdfData.text);
      
      if (textChunks.length > 0) {
        for (const chunk of textChunks) {
          if (!embeddingModel.embedContent) {
            throw new Error('Embedding model does not support embedContent');
          }
          const embeddingResult = await embeddingModel.embedContent(chunk);
          const embedding = embeddingResult.embedding.values;
          await sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file) VALUES (${chunk}, ${JSON.stringify(embedding)}, 'text', ${sessionId}, ${originalFileName}, FALSE)`;
        }
      }
      
      // Use pdf2pic for image extraction
      const tempFilePath = join(os.tmpdir(), `${Date.now()}-${originalFileName}`);
      await fs.writeFile(tempFilePath, fileBuffer);
      try {
        const convert = pdf2pic.fromPath(tempFilePath, { density: 100, format: "png" });
        const results = await convert.bulk(-1, { responseType: "buffer" });
        
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const blob = await put(`${originalFileName}_page_${i + 1}.png`, result.buffer, { access: 'public', addRandomSuffix: true });
          const imagePart: Part = { inlineData: { data: result.buffer.toString("base64"), mimeType: 'image/png' } };
          const prompt = `Analyze this image from page ${i + 1} of a PDF document. Extract ALL visible details:
1. Content type (chart, diagram, photo, text, table, etc.)
2. All visible text (transcribe exactly)
3. If people: describe physical features, clothing, expressions
4. If objects: describe colors, materials, shapes, brands, text on items
5. If charts/graphs: extract all data points, labels, and values
6. Background details, setting, context
7. Any numbers, dates, or specific information

Be comprehensive and specific. Format: [Page ${i + 1}] [TYPE: content_type] Complete detailed description.`;
          if (!visionModel.generateContent) {
            throw new Error('Vision model does not support generateContent');
          }
          const descriptionResult = await visionModel.generateContent([prompt, imagePart]);
          const richDescription = descriptionResult?.response?.text ? descriptionResult.response.text() : 'Image analysis failed';
          
          if (!embeddingModel.embedContent) {
            throw new Error('Embedding model does not support embedContent');
          }
          const embeddingResult = await embeddingModel.embedContent(richDescription);
          const embedding = embeddingResult.embedding.values;
          
          await sql`INSERT INTO documents (content, embedding, type, url, session_id, source_file, is_standalone_file) VALUES (${richDescription}, ${JSON.stringify(embedding)}, 'image', ${blob.url}, ${sessionId}, ${originalFileName}, FALSE)`;
        }
      } finally {
        await fs.unlink(tempFilePath);
      }
    } 
    else if (fileType.startsWith('image/')) {
      const imagePart: Part = { inlineData: { data: fileBuffer.toString("base64"), mimeType: fileType } };
      const prompt = `Analyze this image comprehensively. Describe ALL visible details including:
- People: skin tone, hair color, facial features, clothing, age, gender, expressions
- Objects: colors, materials, text, brands, shapes, sizes
- Background: setting, lighting, colors, environment
- Text: transcribe any visible text or numbers exactly
- Overall composition and context

Be specific and thorough in your description.`;
      if (!visionModel.generateContent) {
        throw new Error('Vision model does not support generateContent');
      }
      const descriptionResult = await visionModel.generateContent([prompt, imagePart]);
      const richDescription = descriptionResult?.response?.text ? descriptionResult.response.text() : 'Image analysis failed';

      if (!embeddingModel.embedContent) {
        throw new Error('Embedding model does not support embedContent');
      }
      const embeddingResult = await embeddingModel.embedContent(richDescription);
      const embedding = embeddingResult.embedding.values;

      await sql`INSERT INTO documents (content, embedding, type, url, session_id, source_file, is_standalone_file) VALUES (${richDescription}, ${JSON.stringify(embedding)}, 'image', ${blobUrl}, ${sessionId}, ${originalFileName}, TRUE)`;
    }
    else if (fileType.startsWith('text/')) {
        const text = fileBuffer.toString('utf-8');
        const textChunks = splitIntoChunks(text);
        
        for (const chunk of textChunks) {
          if (!embeddingModel.embedContent) {
            throw new Error('Embedding model does not support embedContent');
          }
          const embeddingResult = await embeddingModel.embedContent(chunk);
          const embedding = embeddingResult.embedding.values;
          await sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file) VALUES (${chunk}, ${JSON.stringify(embedding)}, 'text', ${sessionId}, ${originalFileName}, TRUE)`;
        }
    }

    return NextResponse.json({ success: true, message: 'Processing complete.' });
  } catch (error) {
    console.error('Error in processing job:', error);
    return NextResponse.json({ error: 'Failed to process file in background' }, { status: 500 });
  }
}