import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/vercel-postgres";
import genAI from "@/app/lib/gemini";
import { splitIntoChunks } from "@/app/lib/rag-utils";
import { put } from "@vercel/blob";
import pdf2pic from 'pdf2pic';
import PDFParser from "pdf2json";
import { Part } from "@google/generative-ai";
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

export async function POST(req: NextRequest) {
  try {
    const { blobUrl, originalFileName, sessionId } = await req.json();

    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
    
    const fileBuffer = Buffer.from(await response.arrayBuffer());
    const fileType = response.headers.get('content-type') || '';

    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

    // --- Case 1: PDF Files (Advanced Processing) ---
    if (fileType === 'application/pdf') {
      // Extract text using pdf2json
      const pdfParser = new PDFParser(null, 1);
      
      const pdfData: any = await new Promise((resolve, reject) => {
        pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError));
        pdfParser.on("pdfParser_dataReady", pdfData => resolve(pdfData));
        pdfParser.parseBuffer(fileBuffer);
      });

      const allText = pdfParser.getRawTextContent();
      const textChunks = splitIntoChunks(allText);
      
      await Promise.all(textChunks.map(async (chunk) => {
        const embeddingResult = await embeddingModel.embedContent(chunk);
        const embedding = embeddingResult.embedding.values;
        await sql`INSERT INTO documents (content, embedding, type, session_id) VALUES (${chunk}, ${JSON.stringify(embedding)}, 'text', ${sessionId})`;
      }));
      
      // Extract images using pdf2pic
      const tempDir = path.join(tmpdir(), `pdf_images_${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });
      
      const tempPdfPath = path.join(tempDir, 'temp.pdf');
      await fs.writeFile(tempPdfPath, fileBuffer);
      
      const options = {
        density: 100,
        savePath: tempDir,
        saveFilename: "page_image",
        format: "png" as const,
        width: 800,
        height: 1100,
      };

      const convert = pdf2pic.fromPath(tempPdfPath, options);
      const results = await convert.bulk(-1, { responseType: "image" });
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.path) {
          const imageBuffer = await fs.readFile(result.path);
          const resizedBuffer = await sharp(imageBuffer).resize({ width: 1024 }).toBuffer();
          
          const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/png' } };
          const descriptionResult = await visionModel.generateContent([`This image is from page ${i + 1} of a PDF document. Describe the image in detail.`, imagePart]);
          const richDescription = descriptionResult.response.text();

          const embeddingResult = await embeddingModel.embedContent(richDescription);
          const embedding = embeddingResult.embedding.values;
          
          const blob = await put(`${originalFileName}_page_${i + 1}.png`, resizedBuffer, { access: 'public', addRandomSuffix: true });
          await sql`INSERT INTO documents (content, embedding, type, url, session_id) VALUES (${richDescription}, ${JSON.stringify(embedding)}, 'image', ${blob.url}, ${sessionId})`;
        }
      }
      
      // Cleanup temp files
      await fs.rm(tempDir, { recursive: true, force: true });
    } 
    // --- Case 2: Standalone Image Files ---
    else if (fileType.startsWith('image/')) {
      const resizedBuffer = await sharp(fileBuffer)
        .resize({ width: 1024, height: 1024, fit: 'inside' })
        .jpeg({ quality: 90 })
        .toBuffer();

      const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/jpeg' } };
      const descriptionResult = await visionModel.generateContent(["Describe this image in detail, focusing on objects, text, and overall context.", imagePart]);
      const richDescription = descriptionResult.response.text();

      const embeddingResult = await embeddingModel.embedContent(richDescription);
      const embedding = embeddingResult.embedding.values;

      await sql`INSERT INTO documents (content, embedding, type, url, session_id) VALUES (${richDescription}, ${JSON.stringify(embedding)}, 'image', ${blobUrl}, ${sessionId})`;
    }
    // --- Case 3: Plain Text Files ---
    else if (fileType.startsWith('text/')) {
        const text = fileBuffer.toString('utf-8');
        const textChunks = splitIntoChunks(text);
        await Promise.all(textChunks.map(async (chunk) => {
            const embeddingResult = await embeddingModel.embedContent(chunk);
            const embedding = embeddingResult.embedding.values;
            await sql`INSERT INTO documents (content, embedding, type, session_id) VALUES (${chunk}, ${JSON.stringify(embedding)}, 'text', ${sessionId})`;
        }));
    }

    return NextResponse.json({ success: true, message: 'Processing complete.' });
  } catch (error) {
    console.error('Error in processing job:', error);
    return NextResponse.json({ error: 'Failed to process file in background' }, { status: 500 });
  }
}

