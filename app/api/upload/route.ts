import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/vercel-postgres";
import genAI from "@/app/lib/gemini";
import { splitIntoChunks } from "@/app/lib/rag-utils";
import { put } from "@vercel/blob";
import pdf from 'pdf-parse';
import pdf2pic from 'pdf2pic';
import { promises as fs } from 'fs';

// Define a standardized type for the content we extract
type ExtractedContent = {
  content: string; // The text to be embedded
  type: 'text' | 'image' | 'pdf';
  buffer?: Buffer; // Only for images that need to be uploaded
  fileName?: string; // Only for images
};

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    
    // =================================================================
    // PHASE 1: EXTRACTION - Populate a list of content to be processed.
    // =================================================================
    const contentsToProcess: ExtractedContent[] = [];

    if (file.type === 'text/plain' || file.type === 'text/markdown') {
      const text = fileBuffer.toString('utf-8');
      const chunks = splitIntoChunks(text);
      chunks.forEach(chunk => contentsToProcess.push({ content: chunk, type: 'text' }));
    } 
    else if (file.type.startsWith('image/')) {
      contentsToProcess.push({
        content: `Image file named ${file.name}`,
        type: 'image',
        buffer: fileBuffer,
        fileName: file.name
      });
    } 
    else if (file.type === 'application/pdf') {
      // Gracefully handle text extraction
      try {
        const pdfData = await pdf(fileBuffer);
        const textChunks = splitIntoChunks(pdfData.text);
        textChunks.forEach(chunk => contentsToProcess.push({ content: chunk, type: 'text' }));
      } catch (pdfError) {
        console.warn('PDF text extraction failed:', pdfError);
      }

      // Gracefully handle image extraction
      try {
        const convert = pdf2pic.fromBuffer(fileBuffer, { density: 100, format: "png", width: 600, height: 800 });
        const results = await convert.bulk(-1);
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (!result.path) continue;
          
          const imgBuffer = await fs.readFile(result.path);
          contentsToProcess.push({
            content: `Image from page ${i + 1} of ${file.name}`,
            type: 'image',
            buffer: imgBuffer,
            fileName: `${file.name.replace('.pdf', '_page_')}${i + 1}.png`
          });
          await fs.unlink(result.path); // Clean up immediately
        }
      } catch (imageError) {
        console.warn('PDF image conversion failed:', imageError);
      }
      
      // If both failed, store a placeholder
      if (contentsToProcess.length === 0) {
        contentsToProcess.push({ content: `PDF file: ${file.name}`, type: 'pdf' });
      }
    } 
    else {
      return NextResponse.json({ error: `Unsupported file type ${file.type}` }, { status: 400 });
    }

    // =================================================================
    // PHASE 2: PROCESSING - Embed and store all extracted content concurrently.
    // =================================================================
    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });

    await Promise.all(contentsToProcess.map(async (item) => {
      const embeddingResponse = await embeddingModel.embedContent(item.content);
      const embedding = embeddingResponse.embedding.values;

      if (item.type === 'image' && item.buffer && item.fileName) {
        const blob = await put(item.fileName, item.buffer, { access: 'public' });
        await sql`INSERT INTO documents (content, embedding, type, url) VALUES (${item.content}, ${JSON.stringify(embedding)}, 'image', ${blob.url})`;
      } else {
        await sql`INSERT INTO documents (content, embedding, type) VALUES (${item.content}, ${JSON.stringify(embedding)}, ${item.type})`;
      }
    }));

    return NextResponse.json({ success: true, message: 'File processed successfully!' }, { status: 200 });

  } catch (error) {
    console.error('Error processing file:', error);
    return NextResponse.json({ error: 'Failed to process file' }, { status: 500 });
  }
}