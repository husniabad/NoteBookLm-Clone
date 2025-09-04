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

interface PDFPage {
  Texts?: Array<{
    R?: Array<{
      T?: string;
    }>;
  }>;
}

interface PDFData {
  Pages?: PDFPage[];
}

interface PDFParserWithData extends PDFParser {
  data?: PDFData;
}

export async function POST(req: NextRequest) {
  try {
    const { fileBuffer: bufferArray, fileType, originalFileName, sessionId, blobUrl } = await req.json();
    
    const fileBuffer = Buffer.from(bufferArray);

    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
    const isProduction = process.env.VERCEL_ENV === 'production';

    if (fileType === 'application/pdf') {
      if (isProduction) {
        const pdfParser = new PDFParser(null, true);
        
        await new Promise<void>((resolve, reject) => {
          pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError));
          pdfParser.on("pdfParser_dataReady", () => resolve());
          pdfParser.parseBuffer(fileBuffer);
        });

        // Extract text by pages
        const pages = (pdfParser as PDFParserWithData).data?.Pages || [];
        
        if (pages.length > 0) {
          const allChunks: string[] = [];
          
          // Extract text from all pages
          pages.forEach((page: PDFPage, pageIndex: number) => {
            const pageTexts: string[] = [];
            
            if (page.Texts) {
              page.Texts.forEach((textItem) => {
                if (textItem.R) {
                  textItem.R.forEach((run) => {
                    if (run.T) {
                      pageTexts.push(decodeURIComponent(run.T));
                    }
                  });
                }
              });
            }
            
            const pageText = pageTexts.join(' ').replace(/\s+/g, ' ').trim();
            if (pageText) {
              const pageContent = `[Page ${pageIndex + 1}] ${pageText}`;
              allChunks.push(...splitIntoChunks(pageContent));
            }
          });
          
          // Batch process embeddings and database writes
          if (allChunks.length > 0) {
            if (!embeddingModel.embedContent) {
              throw new Error('Embedding model does not support embedContent');
            }
            
            const embeddings = await Promise.all(allChunks.map(chunk => embeddingModel.embedContent!(chunk)));
            const insertPromises = allChunks.map((chunk, i) => {
              const pageNum = Math.floor(i / 3) + 1; // Estimate page from chunk index
              return sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file, url, page_number) VALUES (${chunk}, ${JSON.stringify(embeddings[i].embedding.values)}, 'text', ${sessionId}, ${originalFileName}, FALSE, ${blobUrl}, ${pageNum})`;
            });
            await Promise.all(insertPromises);
          }
        } else {
          // Fallback to original method
          const allText = pdfParser.getRawTextContent();
          const textChunks = splitIntoChunks(allText);
          
          if (textChunks.length > 0) {
            if (!embeddingModel.embedContent) {
              throw new Error('Embedding model does not support embedContent');
            }
            const embeddings = await Promise.all(textChunks.map(chunk => embeddingModel.embedContent!(chunk)));
            const insertPromises = textChunks.map((chunk, i) => 
              sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file, url, page_number) VALUES (${chunk}, ${JSON.stringify(embeddings[i].embedding.values)}, 'text', ${sessionId}, ${originalFileName}, FALSE, ${blobUrl}, 1)`
            );
            await Promise.all(insertPromises);
          }
        }
      }
      
      // Development: Use pdf2pic for comprehensive analysis
      if (!isProduction) {
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
          const metadata = await sharp(imageBuffer).metadata();
          const resizedBuffer = metadata.width && metadata.width > 800 
            ? await sharp(imageBuffer).resize({ width: 800 }).toBuffer()
            : imageBuffer;
          
          const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/png' } };
          
          const prompt = `Comprehensively analyze page ${i + 1} of this PDF:
1. Extract ALL visible text exactly as written
2. Identify content type (document, chart, form, etc.)
3. Describe visual elements (images, diagrams, charts with data)
4. Note formatting, layout, and structure
5. Extract numbers, dates, and specific details
6. Describe any people, objects, or scenes if present
Be thorough - this is the only analysis for this page. Format: [Page ${i + 1}] [COMPLETE] full description.`;
          
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
            sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file, url, page_number) VALUES (${desc}, ${JSON.stringify(embeddings[i].embedding.values)}, 'text', ${sessionId}, ${originalFileName}, FALSE, ${blobUrl}, ${i + 1})`
          );
          await Promise.all(insertPromises);
        }
        
        await fs.rm(tempDir, { recursive: true, force: true });
      }
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
      const descriptionResult = await visionModel.generateContent(["Analyze this image comprehensively. Extract ALL text exactly as written. Describe visual elements: people (appearance, clothing, actions), objects (colors, materials, brands), setting (location, lighting, atmosphere), and any charts/data if present. Be specific and thorough.", imagePart]);
      const richDescription = descriptionResult!.response.text();

      if (!embeddingModel.embedContent) {
        throw new Error('Embedding model does not support embedContent');
      }
      const embeddingResult = await embeddingModel.embedContent(richDescription);
      const embedding = embeddingResult.embedding.values;

      await sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file, url, page_number) VALUES (${richDescription}, ${JSON.stringify(embedding)}, 'image', ${sessionId}, ${originalFileName}, TRUE, ${blobUrl}, 1)`;
    }
    else if (fileType.startsWith('text/')) {
        const text = fileBuffer.toString('utf-8');
        const textChunks = splitIntoChunks(text);
        if (!embeddingModel.embedContent) {
          throw new Error('Embedding model does not support embedContent');
        }
        const embeddings = await Promise.all(textChunks.map(chunk => embeddingModel.embedContent!(chunk)));
        const insertPromises = textChunks.map((chunk, i) => 
          sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file, url, page_number) VALUES (${chunk}, ${JSON.stringify(embeddings[i].embedding.values)}, 'text', ${sessionId}, ${originalFileName}, TRUE, ${blobUrl}, 1)`
        );
        await Promise.all(insertPromises);
    }

    return NextResponse.json({ success: true, message: 'Processing complete.' });
  } catch (error) {
    console.error('Error in processing job:', error);
    return NextResponse.json({ error: 'Failed to process file in background' }, { status: 500 });
  }
}