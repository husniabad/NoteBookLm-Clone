import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/vercel-postgres";
import genAI from "@/app/lib/gemini";
import { splitIntoChunks } from "@/app/lib/rag-utils";

import pdf2pic from 'pdf2pic';
import PDFParser from "pdf2json";
import { Part } from "@google/generative-ai";
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

export async function POST(req: NextRequest) {
  try {
    const { blobUrl, sessionId } = await req.json();

    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
    
    const fileBuffer = Buffer.from(await response.arrayBuffer());
    const fileType = response.headers.get('content-type') || '';

    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

    if (fileType === 'application/pdf') {
      const pdfParser = new PDFParser(null, true);
      
      await new Promise<void>((resolve, reject) => {
        pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError));
        pdfParser.on("pdfParser_dataReady", () => resolve());
        pdfParser.parseBuffer(fileBuffer);
      });

      const allText = pdfParser.getRawTextContent();
      const textChunks = splitIntoChunks(allText);
      

      if (textChunks.length > 0) {
        const textEmbeddingPromises = textChunks.map(chunk => embeddingModel.embedContent(chunk));
        const textEmbeddings = await Promise.all(textEmbeddingPromises);
        
        const textInsertPromises = textChunks.map((chunk, i) => 
          sql`INSERT INTO documents (content, embedding, type, session_id) VALUES (${chunk}, ${JSON.stringify(textEmbeddings[i].embedding.values)}, 'text', ${sessionId})`
        );
        await Promise.all(textInsertPromises);
      }
      

      const tempDir = path.join(tmpdir(), `pdf_images_${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });
      
      const tempPdfPath = path.join(tempDir, 'temp.pdf');
      await fs.writeFile(tempPdfPath, fileBuffer);
      
      const options = {
        density: 100,
        savePath: tempDir,
        saveFilename: "page_image",
        format: "png" as const,
        width: 400,
        height: 550,
      };

      const convert = pdf2pic.fromPath(tempPdfPath, options);
      const results = await convert.bulk(-1, { responseType: "image" });
      

      const imagePromises = results.map(async (result: { path?: string }, i: number) => {
        if (!result.path) return null;
        
        const imageBuffer = await fs.readFile(result.path);
        const resizedBuffer = await sharp(imageBuffer).resize({ width: 512 }).toBuffer();
        
        const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/png' } };
        const prompt = `Analyze this image from page ${i + 1} of a PDF. Provide:
1. Content type (chart, diagram, photo, text, table, etc.)
2. Detailed description including all visible text
3. Key data points if it's a chart/graph
4. Any important visual elements

Format: [Page ${i + 1}] [TYPE: content_type] Detailed description with all text and data.`;
        
        const descriptionResult = await visionModel.generateContent([prompt, imagePart]);
        return descriptionResult.response.text();
      });
      
      const descriptions = (await Promise.all(imagePromises)).filter(Boolean) as string[];
      
      if (descriptions.length > 0) {

        const embeddingPromises = descriptions.map(desc => embeddingModel.embedContent(desc));
        const embeddings = await Promise.all(embeddingPromises);
        

        const insertPromises = descriptions.map((desc, i) => 
          sql`INSERT INTO documents (content, embedding, type, session_id) VALUES (${desc}, ${JSON.stringify(embeddings[i].embedding.values)}, 'text', ${sessionId})`
        );
        await Promise.all(insertPromises);
      }
      

      await fs.rm(tempDir, { recursive: true, force: true });
    } 

    else if (fileType.startsWith('image/')) {
      const resizedBuffer = await sharp(fileBuffer)
        .resize({ width: 800, height: 800, fit: 'inside' })
        .jpeg({ quality: 90 })
        .toBuffer();

      const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/jpeg' } };
      const descriptionResult = await visionModel.generateContent(["Describe this image in detail, focusing on objects, text, and overall context.", imagePart]);
      const richDescription = descriptionResult.response.text();

      const embeddingResult = await embeddingModel.embedContent(richDescription);
      const embedding = embeddingResult.embedding.values;

      await sql`INSERT INTO documents (content, embedding, type, url, session_id) VALUES (${richDescription}, ${JSON.stringify(embedding)}, 'image', ${blobUrl}, ${sessionId})`;
    }

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

