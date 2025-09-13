import genAI from './ai-provider';

export interface DocumentMetadata {
  type: 'code' | 'markdown' | 'legal' | 'academic' | 'business' | 'technical' | 'general';
  title?: string;
  headers: string[];
  entities: string[];
  topics: string[];
}

export interface SemanticChunk {
  content: string;
  type: 'paragraph' | 'section' | 'list' | 'code' | 'table';
  metadata?: Record<string, unknown>;
}

export async function analyzeDocumentStructure(content: string, filename: string): Promise<DocumentMetadata> {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  
  const prompt = `Analyze this document and extract metadata:

Filename: ${filename}
Content: ${content.substring(0, 2000)}...

Return JSON with:
{
  "type": "code|markdown|legal|academic|business|technical|general",
  "title": "extracted title or null",
  "headers": ["header1", "header2"],
  "entities": ["person", "company", "location"],
  "topics": ["topic1", "topic2"]
}`;

  try {
    if (!('generateContent' in model)) {
          throw new Error('Vision model does not support generateContent');
        }
    const result = await (model as { generateContent: (parts: unknown[]) => Promise<{ response?: { text(): string } }> }).generateContent([prompt]);
    return JSON.parse(result?.response?.text() || '{"type": "general", "headers": [], "entities": [], "topics": []}');
  } catch {
    return { type: 'general', headers: [], entities: [], topics: [] };
  }
}

export function createSemanticChunks(content: string): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  
  // Split by double newlines (paragraphs)
  const sections = content.split(/\n\s*\n/).filter(s => s.trim().length > 0);
  
  for (const section of sections) {
    const trimmed = section.trim();
    
    // Detect chunk type
    let chunkType: SemanticChunk['type'] = 'paragraph';
    
    if (trimmed.match(/^```|^    /m)) chunkType = 'code';
    else if (trimmed.match(/^[#*-]\s|^\d+\./m)) chunkType = 'list';
    else if (trimmed.match(/^\|.*\|/m)) chunkType = 'table';
    else if (trimmed.match(/^#{1,6}\s/m)) chunkType = 'section';
    
    // Split large chunks while preserving boundaries
    if (trimmed.length > 1000) {
      const sentences = trimmed.split(/[.!?]\s+/);
      let currentChunk = '';
      
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > 800) {
          if (currentChunk) chunks.push({ content: currentChunk.trim(), type: chunkType });
          currentChunk = sentence;
        } else {
          currentChunk += (currentChunk ? '. ' : '') + sentence;
        }
      }
      if (currentChunk) chunks.push({ content: currentChunk.trim(), type: chunkType });
    } else {
      chunks.push({ content: trimmed, type: chunkType });
    }
  }
  
  return chunks.filter(c => c.content.length > 20);
}