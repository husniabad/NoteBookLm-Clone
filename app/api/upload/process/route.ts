import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/vercel-postgres";
import genAI from "@/app/lib/ai-provider";
import { splitIntoChunks } from "@/app/lib/rag-utils";
import pdf2pic from 'pdf2pic';
import PDFParser from "pdf2json";
import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
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
      // Use pdf2json for text extraction
      const pdfParser = new PDFParser(null, true);
      
      await new Promise<void>((resolve, reject) => {
        pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError));
        pdfParser.on("pdfParser_dataReady", () => resolve());
        pdfParser.parseBuffer(fileBuffer);
      });

      const allText = pdfParser.getRawTextContent();
      const textChunks = splitIntoChunks(allText);
      
      if (textChunks.length > 0) {
        if (!embeddingModel.embedContent) {
          throw new Error('Embedding model does not support embedContent');
        }
        const textEmbeddingPromises = textChunks.map(chunk => embeddingModel.embedContent!(chunk));
        const textEmbeddings = await Promise.all(textEmbeddingPromises);
        
        const textInsertPromises = textChunks.map((chunk, i) => 
          sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file) VALUES (${chunk}, ${JSON.stringify(textEmbeddings[i].embedding.values)}, 'text', ${sessionId}, ${originalFileName}, FALSE)`
        );
        await Promise.all(textInsertPromises);
      }
      
      // Use pdf2pic for image extraction with proper configuration
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
        // Add delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, i * 1000));
        if (!result.path) return null;
        
        const imageBuffer = await fs.readFile(result.path);
        const metadata = await sharp(imageBuffer).metadata();
        const resizedBuffer = metadata.width && metadata.width > 800 
          ? await sharp(imageBuffer).resize({ width: 800 }).toBuffer()
          : imageBuffer;
        
        const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/png' } };
        const prompt = `Analyze this image from page ${i + 1} of a PDF. Extract ALL visible details:
1. Content type (chart, diagram, photo, text, table, etc.)
2. All visible text (transcribe exactly)
3. If people: describe physical features (skin tone, hair color, clothing, age, gender, facial features)
4. If objects: describe colors, materials, shapes, brands, text on items
5. If charts/graphs: extract all data points and labels
6. Background details, lighting, setting
7. Any numbers, dates, or specific information

Be comprehensive and specific. Format: [Page ${i + 1}] [TYPE: content_type] Complete detailed description.`;
        
        if (!visionModel.generateContent) {
          throw new Error('Vision model does not support generateContent');
        }
        const descriptionResult = await visionModel.generateContent([prompt, imagePart]);
        return descriptionResult!.response.text();
      });
      
      const descriptions = (await Promise.all(imagePromises)).filter(Boolean) as string[];
      
      if (descriptions.length > 0) {
        if (!embeddingModel.embedContent) {
          throw new Error('Embedding model does not support embedContent');
        }
        const embeddingPromises = descriptions.map(desc => embeddingModel.embedContent!(desc));
        const embeddings = await Promise.all(embeddingPromises);
        
        const insertPromises = descriptions.map((desc, i) => 
          sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file) VALUES (${desc}, ${JSON.stringify(embeddings[i].embedding.values)}, 'text', ${sessionId}, ${originalFileName}, FALSE)`
        );
        await Promise.all(insertPromises);
      }
      
      // Clean up temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    } 
    else if (fileType.startsWith('image/')) {
      const metadata = await sharp(fileBuffer).metadata();
      const resizedBuffer = (metadata.width && metadata.width > 1200) || (metadata.height && metadata.height > 1200)
        ? await sharp(fileBuffer).resize({ width: 1200, height: 1200, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer()
        : fileBuffer;

      const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/jpeg' } };
      if (!visionModel.generateContent) {
        throw new Error('Vision model does not support generateContent');
      }
      const descriptionResult = await visionModel.generateContent(["Analyze this image comprehensively. Describe ALL visible details including: people (skin tone, hair color, facial features, clothing, age, gender), objects (colors, materials, text, brands), background (setting, lighting, colors), any text or numbers visible, and overall composition. Be specific and thorough.", imagePart]);
      const richDescription = descriptionResult!.response.text();

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
        if (!embeddingModel.embedContent) {
          throw new Error('Embedding model does not support embedContent');
        }
        await Promise.all(textChunks.map(async (chunk) => {
            const embeddingResult = await embeddingModel.embedContent!(chunk);
            const embedding = embeddingResult.embedding.values;
            await sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file) VALUES (${chunk}, ${JSON.stringify(embedding)}, 'text', ${sessionId}, ${originalFileName}, TRUE)`;
        }));
    }

    return NextResponse.json({ success: true, message: 'Processing complete.' });
  } catch (error) {
    console.error('Error in processing job:', error);
    return NextResponse.json({ error: 'Failed to process file in background' }, { status: 500 });
  }
}