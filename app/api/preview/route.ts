import { NextRequest, NextResponse } from 'next/server';
import genAI from '@/app/lib/ai-provider';
import PDFParser from 'pdf2json';

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

const documentCache = new Map<string, { content: string | string[]; type: 'text' | 'pdf'; timestamp: number }>();
const citationCache = new Map<string, { fullContent: string; highlightPhrases: string[]; timestamp: number }>();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Configurable parameters
const CONFIG = {
  POETRY_MAX_LINE_WORDS: 12,
  LONG_QUOTE_MIN_CHARS: 100,
  PROSE_DOMINANCE_THRESHOLD: 0.80,
  PHRASE_EXTRACTION_COUNT: [3, 6],
  PHRASE_WORD_COUNT: [3, 8]
};

async function getDocumentContent(blobUrl: string, sourceFile: string) {
  const cached = documentCache.get(blobUrl);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached;
  }

  const response = await fetch(blobUrl);
  if (!response.ok) throw new Error('Failed to fetch document');

  const buffer = await response.arrayBuffer();
  const fileBuffer = Buffer.from(buffer);

  if (sourceFile.toLowerCase().endsWith('.pdf')) {
    const pdfParser = new PDFParser(null, true);
    
    await new Promise<void>((resolve, reject) => {
      pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError));
      pdfParser.on("pdfParser_dataReady", () => resolve());
      pdfParser.parseBuffer(fileBuffer);
    });

    const pages = (pdfParser as PDFParserWithData).data?.Pages || [];
    const pageTexts: string[] = [];

    pages.forEach((page: PDFPage) => {
      const pageTexts_temp: string[] = [];
      
      if (page.Texts) {
        page.Texts.forEach((textItem) => {
          if (textItem.R) {
            textItem.R.forEach((run) => {
              if (run.T) {
                pageTexts_temp.push(decodeURIComponent(run.T));
              }
            });
          }
        });
      }
      
      const pageText = pageTexts_temp.join(' ').replace(/\s+/g, ' ').trim();
      pageTexts.push(pageText);
    });

    const cached = { content: pageTexts, type: 'pdf' as const, timestamp: Date.now() };
    documentCache.set(blobUrl, cached);
    return cached;

  } else if (sourceFile.toLowerCase().endsWith('.txt')) {
    const text = fileBuffer.toString('utf-8');
    const cached = { content: text, type: 'text' as const, timestamp: Date.now() };
    documentCache.set(blobUrl, cached);
    return cached;
  }

  throw new Error('Unsupported file type');
}

export async function POST(req: NextRequest) {
  try {
    const { blobUrl, sourceFile, contextSnippet, pageNumber, specificContent, sessionId } = await req.json();
    
    if (!blobUrl || !sourceFile || !contextSnippet) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    // Check citation cache first (include session ID)
    const cacheKey = `${sessionId || 'default'}:${blobUrl}:${pageNumber || 0}:${contextSnippet.substring(0, 100)}`;
    const cachedCitation = citationCache.get(cacheKey);
    if (cachedCitation && Date.now() - cachedCitation.timestamp < CACHE_DURATION) {
      return NextResponse.json({
        fullContent: cachedCitation.fullContent,
        highlightPhrases: cachedCitation.highlightPhrases
      });
    }

    // Use specific content if provided, otherwise fetch document
    let documentContent = '';
    

    if (specificContent) {
      documentContent = specificContent;
    } else {
      // Fallback to fetching document content
      const cachedDoc = await getDocumentContent(blobUrl, sourceFile);
      
      if (cachedDoc.type === 'pdf' && Array.isArray(cachedDoc.content)) {
        if (pageNumber && pageNumber > 0 && pageNumber <= cachedDoc.content.length) {
          documentContent = cachedDoc.content[pageNumber - 1];
        } else {
          documentContent = cachedDoc.content.join('\n\n');
        }
      } else {
        documentContent = typeof cachedDoc.content === 'string' ? cachedDoc.content : '';
      }
    }

    // Use the specific document content directly (already the right chunk)
    const relevantParagraph = documentContent.trim();
  
    
    // Module 1: Pattern-Based Detection
    function analyzeTextStructure(text: string) {
      const lines = text.split('\n').filter(line => line.trim().length > 0);
      const totalWords = text.split(/\s+/).length;
      
      // Check for structured text (lists, indentation)
      const structuredLines = lines.filter(line => 
        /^\s*[\*\-\d+\.]\s/.test(line) || // Lists
        /^\s{4,}/.test(line) // Indentation
      );
      if (structuredLines.length > lines.length * 0.3) {
        return { type: 'FULL_HIGHLIGHT', reason: 'structured_text' };
      }
      
      // Check for dialogue (quotation marks + speech verbs)
      const hasQuotes = /["']/.test(text);
      const hasSpeechVerbs = /\b(said|asked|yelled|whispered|declared|announced|shouted|replied|responded)\b/i.test(text);
      if (hasQuotes && hasSpeechVerbs) {
        return { type: 'FULL_HIGHLIGHT', reason: 'dialogue' };
      }
      
      // Check for poetry (line length variance + frequent newlines)
      if (lines.length > 3) {
        const shortLines = lines.filter(line => {
          const words = line.trim().split(/\s+/).length;
          return words <= CONFIG.POETRY_MAX_LINE_WORDS;
        });
        const hasStanzaBreaks = /\n\s*\n/.test(text);
        
        if (shortLines.length > lines.length * 0.6 && hasStanzaBreaks) {
          return { type: 'FULL_HIGHLIGHT', reason: 'poetry' };
        }
      }
      
      // Check for long quotations
      const longQuoteMatch = text.match(/["']([^"']{100,})["']/g);
      if (longQuoteMatch) {
        return { type: 'FULL_HIGHLIGHT', reason: 'long_quote' };
      }
      
      // Mixed content rule: Check prose dominance
      const proseWords = text.replace(/["'].*?["']/g, '').split(/\s+/).length;
      const proseDominance = proseWords / totalWords;
      
      if (proseDominance >= CONFIG.PROSE_DOMINANCE_THRESHOLD) {
        return { type: 'PHRASE_HIGHLIGHT', reason: 'prose_dominant' };
      }
      
      // Default to phrase highlighting for regular prose
      return { type: 'PHRASE_HIGHLIGHT', reason: 'regular_prose' };
    }
    
    const analysisResult = analyzeTextStructure(relevantParagraph);
    
    const textModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    // Module 1 Result: Full Highlighting
    if (analysisResult.type === 'FULL_HIGHLIGHT') {
      const result = {
        fullContent: relevantParagraph,
        highlightPhrases: [relevantParagraph.trim()]
      };
      
      citationCache.set(cacheKey, {
        fullContent: result.fullContent,
        highlightPhrases: result.highlightPhrases,
        timestamp: Date.now()
      });
      
      return NextResponse.json(result);
    }
    
    // Module 2: AI-Powered Phrase Extraction
    
    async function extractContextualPhrases(text: string, context: string) {
      const aiPrompt = `Citation Context: "${context}"

Text Paragraph: "${text}"

Extract ${CONFIG.PHRASE_EXTRACTION_COUNT[0]}-${CONFIG.PHRASE_EXTRACTION_COUNT[1]} key phrases (${CONFIG.PHRASE_WORD_COUNT[0]}-${CONFIG.PHRASE_WORD_COUNT[1]} words each) from the paragraph that are most semantically related to the citation context.

Focus on:
- Complete meaningful phrases, not individual words
- Content that directly relates to the context
- Important concepts, entities, or technical terms

Return phrases separated by | (pipe). Example: "urban development project|environmental impact assessment|community consultation process"`;
      
      try {
        if (!textModel.generateContent) {
          throw new Error('Text model generateContent not available');
        }
        
        const aiResult = await textModel.generateContent([aiPrompt]);
        const aiResponse = aiResult?.response?.text() || '';
        const aiPhrases = aiResponse.split('|').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
        
        // Validate phrases: exist in text, correct word count, meaningful length
        const validPhrases = aiPhrases.filter((phrase: string) => {
          const wordCount = phrase.split(/\s+/).length;
          const isValidLength = wordCount >= CONFIG.PHRASE_WORD_COUNT[0] && wordCount <= CONFIG.PHRASE_WORD_COUNT[1];
          const existsInText = text.toLowerCase().includes(phrase.toLowerCase());
          
          return isValidLength && existsInText && phrase.length > 10;
        });
        
        // Return within configured count range
        const maxCount = CONFIG.PHRASE_EXTRACTION_COUNT[1];
        return validPhrases.slice(0, maxCount);
        
      } catch {
        // Fallback: Extract key terms from context that exist in text
        const contextWords = context.split(/\s+/).filter((w: string) => 
          w.length > 4 && text.toLowerCase().includes(w.toLowerCase())
        );
        return contextWords.slice(0, CONFIG.PHRASE_EXTRACTION_COUNT[0]);
      }
    }
    
    const highlightPhrases = await extractContextualPhrases(relevantParagraph, contextSnippet);
    

    // Cache the citation result
    citationCache.set(cacheKey, {
      fullContent: relevantParagraph,
      highlightPhrases: highlightPhrases,
      timestamp: Date.now()
    });
    
    return NextResponse.json({
      fullContent: relevantParagraph,
      highlightPhrases: highlightPhrases
    });
    
  } catch (error) {
    console.error('Preview API error:', error);
    return NextResponse.json({ error: 'Failed to generate preview' }, { status: 500 });
  }
}