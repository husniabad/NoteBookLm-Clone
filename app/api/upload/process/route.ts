import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/vercel-postgres";
import genAI from "@/app/lib/ai-provider";
import sharp from 'sharp';
import { Part } from "@google/generative-ai";
import { convertPDFToImages } from "@/app/lib/pdf-converter";
import { analyzeDocumentStructure, createSemanticChunks } from "@/app/lib/document-analyzer";
import { correlateTextWithVisuals, assembleMultiPageContent } from "@/app/lib/pdf-enhancer";

export async function POST(req: NextRequest) {
  try {
    const { fileBuffer: bufferArray, fileType, originalFileName, sessionId, blobUrl } = await req.json();
    
    const fileBuffer = Buffer.from(bufferArray);

    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const visionModel = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

    if (fileType === 'application/pdf') {
      const pages = await convertPDFToImages(fileBuffer);
      
      const descriptions: string[] = [];
      
      // Process pages sequentially with retry logic to avoid ECONNRESET
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const imagePart: Part = { inlineData: { data: page.buffer.toString("base64"), mimeType: 'image/png' } };
        
        const prompt = `Analyze page ${page.pageNumber} using EXACTLY this format:

===RAW_TEXT_START===
[Write all visible text here exactly as shown]
===RAW_TEXT_END===

===ANALYSIS_START===
Describe this page comprehensively in natural, flowing paragraphs. Cover the content type (document, chart, storybook, etc.), then describe any images or illustrations in detail. For people, include their appearance, facial features, clothing, expressions, and actions. Describe objects with their colors, materials, and any text or brands visible. Explain the setting, lighting, and atmosphere. Note any charts, diagrams, or data with specific numbers. Mention the layout, formatting, and organization. Include any visible numbers, dates, or text within graphics. Be thorough and detailed - this is the complete visual analysis.
===ANALYSIS_END===

===STRUCTURED_DATA_START===
{"sections": ["section titles/headers found"], "tables": [{"headers": ["col1", "col2"], "rows": [["val1", "val2"]], "caption": "table title"}], "charts": [{"type": "bar|pie|line", "values": {"label": "value"}, "title": "chart title"}], "entities": ["people", "companies", "locations mentioned"]}
===STRUCTURED_DATA_END===

IMPORTANT: Use the exact === markers shown above. Extract actual data values from tables and charts when visible.`;
        
        // Add delay between requests to avoid rate limiting
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        }
        
        // Retry logic for network errors
        let retries = 3;
        while (retries > 0) {
          try {
            if (!('generateContent' in visionModel)) {
              throw new Error('Vision model does not support generateContent');
            }
            const descriptionResult = await (visionModel as { generateContent: (parts: unknown[]) => Promise<{ response?: { text(): string } }> }).generateContent([prompt, imagePart]);
            const description = descriptionResult?.response?.text?.();
            if (description) {
              descriptions.push(description);
            }
            break; // Success, exit retry loop
          } catch (error: unknown) {
            retries--;
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Error processing page ${page.pageNumber}, retries left: ${retries}`, errorMessage);
            
            if (retries === 0) {
              console.error(`Failed to process page ${page.pageNumber} after all retries`);
              // Continue with other pages instead of failing completely
            } else {
              // Wait before retry
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
        }
      }

      if (descriptions.length > 0) {
        const allChunks: Array<{content: string, pageNumber: number, contentType: string, metadata?: Record<string, unknown>}> = [];
        const pageStructures: Array<{content: string, pageNumber: number}> = [];
        
        // Process each page and extract structured data
        for (let i = 0; i < descriptions.length; i++) {
          const desc = descriptions[i];
          const rawTextMatch = desc.match(new RegExp('===RAW_TEXT_START===(.*?)===RAW_TEXT_END===', 's'));
          const analysisMatch = desc.match(new RegExp('===ANALYSIS_START===(.*?)===ANALYSIS_END===', 's'));
          const structuredMatch = desc.match(new RegExp('===STRUCTURED_DATA_START===(.*?)===STRUCTURED_DATA_END===', 's'));
          
          let rawText = rawTextMatch?.[1]?.trim() || '';
          const analysis = analysisMatch?.[1]?.trim() || '';
          let pageStructure = { pageNumber: i + 1, sections: [], tables: [], charts: [], entities: [] };
          
          // Clean up common AI responses that don't contain actual text
          if (rawText.includes('[Extract ALL visible text') || rawText.includes('[Write all visible text')) {
            rawText = '';
          }
          
          // Parse structured data from single AI response
          if (structuredMatch) {
            try {
              const structuredData = JSON.parse(structuredMatch[1].trim());
              pageStructure = { pageNumber: i + 1, ...structuredData };
            } catch {
              // Fallback to empty structure if JSON parsing fails
            }
          }
          
          // Correlate text with visuals if both exist
          const correlations = rawText && analysis ? correlateTextWithVisuals(rawText, analysis) : [];
          
          if (rawText && rawText.length > 10) {
            pageStructures.push({ content: rawText, pageNumber: i + 1 });
            allChunks.push({ 
              content: rawText, 
              pageNumber: i + 1, 
              contentType: 'text',
              metadata: { 
                sections: pageStructure.sections,
                entities: pageStructure.entities,
                correlations
              }
            });
          }
          
          if (analysis && analysis.length > 10) {
            allChunks.push({ 
              content: analysis, 
              pageNumber: i + 1, 
              contentType: 'analysis',
              metadata: pageStructure
            });
          }
          
          // Store structured data separately
          if (pageStructure.tables && pageStructure.tables.length > 0) {
            (pageStructure.tables as Array<{caption?: string, headers: string[], rows: string[][]}>).forEach(table => {
              const tableContent = `Table: ${table.caption || 'Untitled'}\nHeaders: ${table.headers.join(', ')}\nData: ${table.rows.map(row => row.join(', ')).join('; ')}`;
              allChunks.push({ 
                content: tableContent, 
                pageNumber: i + 1, 
                contentType: 'table',
                metadata: table
              });
            });
          }
          
          if (pageStructure.charts && pageStructure.charts.length > 0) {
            (pageStructure.charts as Array<{title?: string, type: string, values: Record<string, unknown>}>).forEach(chart => {
              const chartContent = `Chart: ${chart.title || 'Untitled'} (${chart.type})\nData: ${Object.entries(chart.values).map(([k,v]) => `${k}: ${v}`).join(', ')}`;
              allChunks.push({ 
                content: chartContent, 
                pageNumber: i + 1, 
                contentType: 'chart',
                metadata: chart
              });
            });
          }
          
          // Fallback: if no structured content found, store as analysis
          if (!rawText && !analysis) {
            allChunks.push({ content: desc, pageNumber: i + 1, contentType: 'analysis' });
          }
        }
        
        // Assemble multi-page content for better context
        const assembledPages = assembleMultiPageContent(pageStructures);
        assembledPages.forEach(assembled => {
          if (assembled.pageNumbers.length > 1) {
            allChunks.push({
              content: assembled.content,
              pageNumber: assembled.pageNumbers[0],
              contentType: 'assembled',
              metadata: { pageNumbers: assembled.pageNumbers }
            });
          }
        });
        
        const embeddings = await Promise.all(allChunks.map(chunk => embeddingModel.embedContent!(chunk.content)));
        const insertPromises = allChunks.map((chunk, i) => 
          sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file, url, page_number, content_type, metadata) VALUES (${chunk.content}, ${JSON.stringify(embeddings[i].embedding.values)}, 'text', ${sessionId}, ${originalFileName}, FALSE, ${blobUrl}, ${chunk.pageNumber}, ${chunk.contentType}, ${JSON.stringify(chunk.metadata || {})})`
        );
        await Promise.all(insertPromises);
      }
    } 
    else if (fileType.startsWith('image/')) {
      const metadata = await sharp(fileBuffer).metadata();
      const resizedBuffer = (metadata.width && metadata.width > 1200) || (metadata.height && metadata.height > 1200)
        ? await sharp(fileBuffer).resize({ width: 1200, height: 1200, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer()
        : fileBuffer;

      const imagePart: Part = { inlineData: { data: resizedBuffer.toString("base64"), mimeType: 'image/jpeg' } };
      if (!('generateContent' in visionModel)) {
        throw new Error('Vision model does not support generateContent');
      }
      const descriptionResult = await (visionModel as { generateContent: (parts: unknown[]) => Promise<{ response?: { text(): string } }> }).generateContent(["Analyze this image comprehensively. Extract ALL text exactly as written. Describe visual elements: people (appearance, clothing, actions), objects (colors, materials, brands), setting (location, lighting, atmosphere), and any charts/data if present. Be specific and thorough.", imagePart]);
      const richDescription = descriptionResult?.response?.text?.() || '';

      if (!embeddingModel.embedContent) {
        throw new Error('Embedding model does not support embedContent');
      }

      // Store all image descriptions as single chunks
      const embeddingResult = await embeddingModel.embedContent(richDescription);
      const embedding = embeddingResult.embedding.values;
      await sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file, url, page_number, content_type) VALUES (${richDescription}, ${JSON.stringify(embedding)}, 'image', ${sessionId}, ${originalFileName}, TRUE, ${blobUrl}, 1, 'text')`;
    }
    else if (fileType.startsWith('text/')) {
        const text = fileBuffer.toString('utf-8');
        
        // Analyze document structure and metadata
        const docMetadata = await analyzeDocumentStructure(text, originalFileName);
        
        // Create semantic chunks instead of fixed-size chunks
        const semanticChunks = createSemanticChunks(text);
        
        if (!embeddingModel.embedContent) {
          throw new Error('Embedding model does not support embedContent');
        }
        
        const embeddings = await Promise.all(semanticChunks.map(chunk => embeddingModel.embedContent!(chunk.content)));
        const insertPromises = semanticChunks.map((chunk, i) => 
          sql`INSERT INTO documents (content, embedding, type, session_id, source_file, is_standalone_file, url, page_number, content_type, metadata) VALUES (${chunk.content}, ${JSON.stringify(embeddings[i].embedding.values)}, 'text', ${sessionId}, ${originalFileName}, TRUE, ${blobUrl}, 1, ${chunk.type}, ${JSON.stringify({...docMetadata, chunkType: chunk.type})})`
        );
        await Promise.all(insertPromises);
    }

    return NextResponse.json({ success: true, message: 'Processing complete.' });
  } catch (error) {
    console.error('Error in processing job:', error);
    return NextResponse.json({ error: 'Failed to process file in background' }, { status: 500 });
  }
}