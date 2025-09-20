import genAI from '@/app/lib/ai-provider';
import { Chunk, BlueprintDocument } from './document-search';

interface PageBlueprint {
  page_number: number;
  page_dimensions: { width: number; height: number };
  content_blocks: unknown[];
  combined_markdown: string;
}

interface AnalysisResult {
  type: 'FULL_HIGHLIGHT' | 'PHRASE_HIGHLIGHT';
  reason: string;
}

  export interface Citation {
    source_file: string;
    page_number?: number;
    content_snippet: string;
    blob_url?: string;
    chunk_id?: string;
    specific_content?: string;
    citation_id?: string;
    citation_index?: number;
    highlight_phrases?: string[];
    highlighted_html?: string;
    page_blueprint?: PageBlueprint;
  }

  export class CitationService {
    private static CONFIG = {
      POETRY_MAX_LINE_WORDS: 12,
      PROSE_DOMINANCE_THRESHOLD: 0.80,
      PHRASE_EXTRACTION_COUNT: [3, 6],
      PHRASE_WORD_COUNT: [3, 8]
    };

    static analyzeTextStructure(text: string): AnalysisResult {
      const lines = text.split('\n').filter(line => line.trim().length > 0);
      const totalWords = text.split(/\s+/).length;
      
      const structuredLines = lines.filter(line => 
        /^\s*[\*\-\d+\.]\s/.test(line) || /^\s{4,}/.test(line)
      );
      if (structuredLines.length > lines.length * 0.3) {
        return { type: 'FULL_HIGHLIGHT', reason: 'structured_text' };
      }
      
      const hasQuotes = /["']/.test(text);
      const hasSpeechVerbs = /\b(said|asked|yelled|whispered|declared|announced|shouted|replied|responded)\b/i.test(text);
      if (hasQuotes && hasSpeechVerbs) {
        return { type: 'FULL_HIGHLIGHT', reason: 'dialogue' };
      }
      
      if (lines.length > 2) {
        const shortLines = lines.filter(line => {
          const words = line.trim().split(/\s+/).length;
          return words <= this.CONFIG.POETRY_MAX_LINE_WORDS;
        });
        const hasStanzaBreaks = /\n\s*\n/.test(text);
        const hasPoetryTitle = lines[0] && lines[0].split(/\s+/).length <= 4 && !lines[0].endsWith('.');
        
        if (shortLines.length > lines.length * 0.5 || hasStanzaBreaks || hasPoetryTitle) {
          return { type: 'FULL_HIGHLIGHT', reason: 'poetry' };
        }
      }
      
      const longQuoteMatch = text.match(/["']([^"']{100,})["']/g);
      if (longQuoteMatch) {
        return { type: 'FULL_HIGHLIGHT', reason: 'long_quote' };
      }
      
      const avgWordsPerLine = totalWords / lines.length;
      const hasVerseStructure = avgWordsPerLine < 8 && lines.length > 2;
      
      if (hasVerseStructure) {
        return { type: 'FULL_HIGHLIGHT', reason: 'verse_structure' };
      }
      
      const proseWords = text.replace(/["'].*?["']/g, '').split(/\s+/).length;
      const proseDominance = proseWords / totalWords;
      
      if (proseDominance >= this.CONFIG.PROSE_DOMINANCE_THRESHOLD) {
        return { type: 'PHRASE_HIGHLIGHT', reason: 'prose_dominant' };
      }
      
      return { type: 'PHRASE_HIGHLIGHT', reason: 'regular_prose' } as AnalysisResult;
    }

    static async extractContextualPhrases(text: string, context: string): Promise<string[]> {
      const aiPrompt = `Citation Context: "${context}"\n\nText Paragraph: "${text}"\n\nExtract ${this.CONFIG.PHRASE_EXTRACTION_COUNT[0]}-${this.CONFIG.PHRASE_EXTRACTION_COUNT[1]} key phrases (${this.CONFIG.PHRASE_WORD_COUNT[0]}-${this.CONFIG.PHRASE_WORD_COUNT[1]} words each) from the paragraph that are most semantically related to the citation context.\n\nFocus on:\n- Complete meaningful phrases, not individual words\n- Content that directly relates to the context\n- Important concepts, entities, or technical terms\n\nReturn phrases separated by | (pipe). Example: "urban development project|environmental impact assessment|community consultation process"`;
      
      try {
        const textModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        if (!('generateContent' in textModel)) throw new Error('Text model generateContent not available');
        
        const aiResult = await (textModel as { generateContent: (parts: unknown[]) => Promise<{ response?: { text(): string } }> }).generateContent([aiPrompt]);
        const aiResponse = aiResult?.response?.text() || '';
        const aiPhrases = aiResponse.split('|').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
        
        const validPhrases = aiPhrases.filter((phrase: string) => {
          const wordCount = phrase.split(/\s+/).length;
          const isValidLength = wordCount >= this.CONFIG.PHRASE_WORD_COUNT[0] && wordCount <= this.CONFIG.PHRASE_WORD_COUNT[1];
          const existsInText = text.toLowerCase().includes(phrase.toLowerCase());
          return isValidLength && existsInText && phrase.length > 10;
        });
        
        return validPhrases.slice(0, this.CONFIG.PHRASE_EXTRACTION_COUNT[1]);
      } catch {
        const contextWords = context.split(/\s+/).filter((w: string) => 
          w.length > 4 && text.toLowerCase().includes(w.toLowerCase())
        );
        return contextWords.slice(0, this.CONFIG.PHRASE_EXTRACTION_COUNT[0]);
      }
    }

    static applyHighlighting(content: string, phrases: string[], analysisResult: AnalysisResult): string {
      const isFullHighlight = analysisResult.type === 'FULL_HIGHLIGHT' || 
                            (phrases.length === 1 && phrases[0].trim().length > content.trim().length * 0.8);
      
      let html = content
        .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold text-foreground">$1</strong>')
        .replace(/^(\d+\.)\s/gm, '<span class="font-medium">$1</span> ')
        .replace(/^\s*-\s/gm, '• ')
        .replace(/\n/g, '<br/>');
      
      if (isFullHighlight) {
        html = `<mark class="bg-muted text-foreground font-semibold rounded px-1 py-0.5">${html}</mark>`;
      } else {
        phrases.sort((a, b) => b.length - a.length).forEach(phrase => {
          const useWordBoundaries = phrase.split(/\s+/).length <= 3;
          const pattern = useWordBoundaries ? 
            `\\b(${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b` :
            `(${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`;
          const regex = new RegExp(pattern, 'gi');
          html = html.replace(regex, '<mark class="bg-muted text-foreground font-semibold rounded px-1 py-0.5">$1</mark>');
        });
      }
      
      return html;
    }

    static async extractCitations(
      finalAnswer: string, 
      retrievedChunks: Chunk[], 
      blueprints: BlueprintDocument[]
    ): Promise<Citation[]> {
      const citations: Citation[] = [];
      const extractPattern = /\[SOURCE: ([^\]]+)\]/g;
      let match;
      
      while ((match = extractPattern.exec(finalAnswer)) !== null) {
        const parts = match[1].split(', ');
        const sourceFile = parts[0];
        const pageMatch = parts.find(p => p.startsWith('Page '));
        const pageNumber = pageMatch ? parseInt(pageMatch.replace('Page ', '')) : undefined;
        
        const beforeText = finalAnswer.substring(0, match.index);
        const afterText = finalAnswer.substring(match.index + match[0].length);
        
        const sentenceStart = Math.max(
          beforeText.lastIndexOf('. '),
          beforeText.lastIndexOf('\n'),
          beforeText.lastIndexOf(': '),
          Math.max(0, match.index - 200)
        );
        const sentenceEnd = Math.min(
          afterText.indexOf('. ') !== -1 ? match.index + match[0].length + afterText.indexOf('. ') + 1 : finalAnswer.length,
          afterText.indexOf('\n') !== -1 ? match.index + match[0].length + afterText.indexOf('\n') : finalAnswer.length,
          match.index + match[0].length + 200
        );
        
        let contextSnippet = finalAnswer.substring(sentenceStart, sentenceEnd)
          .replace(/\[SOURCE: [^\]]+\]/g, '')
          .trim();
        
        if (contextSnippet.length < 20) {
          contextSnippet = finalAnswer.substring(
            Math.max(0, match.index - 100),
            Math.min(finalAnswer.length, match.index + match[0].length + 100)
          ).replace(/\[SOURCE: [^\]]+\]/g, '').trim();
        }
        
        let bestSourceDoc = null;
        let bestScore = 0;
        
        const sourceChunks = retrievedChunks.filter(chunk => {
          const blueprint = blueprints.find(bp => bp.id === chunk.document_id);
          return blueprint?.source_file === sourceFile && 
                 (!pageNumber || chunk.page_number === pageNumber);
        });
        
        for (const chunk of sourceChunks) {
          if (!chunk.content) continue;
          
          const chunkContent = chunk.content.toLowerCase();
          const contextWords = contextSnippet.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
          
          let score = 0;
          
          for (let len = 5; len >= 3; len--) {
            for (let i = 0; i <= contextWords.length - len; i++) {
              const phrase = contextWords.slice(i, i + len).join(' ');
              if (chunkContent.includes(phrase)) {
                score += len * 15;
              }
            }
          }
          
          for (const word of contextWords) {
            if (chunkContent.includes(word)) {
              score += word.length * 2;
            }
          }
          
          if (score > bestScore) {
            bestScore = score;
            bestSourceDoc = {
              id: chunk.document_id,
              content: chunk.content,
              source_file: sourceFile,
              page_number: chunk.page_number,
              url: 'placeholder'
            };
          }
        }
                
        const sourceDoc = bestSourceDoc || (sourceChunks[0] ? {
          id: sourceChunks[0].document_id,
          content: sourceChunks[0].content,
          source_file: sourceFile,
          page_number: sourceChunks[0].page_number,
          url: 'placeholder'
        } : null);
        
        if (sourceDoc) {
          const blueprint = blueprints.find(bp => bp.id === sourceDoc.id);
          const blobUrl = blueprint?.pdf_url || 
            (blueprint?.blueprint && !Array.isArray(blueprint.blueprint) ? blueprint.blueprint.blob_url : undefined) || 
            'placeholder';
          
          // Find the specific page blueprint
          const pageBlueprint = blueprint?.blueprint && Array.isArray(blueprint.blueprint) 
            ? blueprint.blueprint.find((page: PageBlueprint) => 
                page.page_number === (sourceDoc.page_number || pageNumber)
              )
            : null;
          
          const analysisResult = this.analyzeTextStructure(sourceDoc.content || '');
          let highlightPhrases: string[];

          if (analysisResult.type === 'FULL_HIGHLIGHT') {
            highlightPhrases = [(sourceDoc.content || '').trim()];
          } else {
            highlightPhrases = await this.extractContextualPhrases(sourceDoc.content || '', contextSnippet);
          }

          citations.push({
            source_file: sourceFile,
            page_number: sourceDoc.page_number || pageNumber,
            content_snippet: contextSnippet,
            blob_url: blobUrl,
            chunk_id: sourceDoc.id,
            specific_content: sourceDoc.content,
            highlight_phrases: highlightPhrases,
            highlighted_html: this.applyHighlighting(sourceDoc.content || '', highlightPhrases, analysisResult),
            citation_id: `${sourceDoc.id}-${Date.now()}-${Math.random()}`,
            citation_index: citations.length,
            page_blueprint: pageBlueprint || undefined
          });
        }
      }

      return citations;
    }

    static processResponse(finalAnswer: string, citations: Citation[]): string {
      let processedAnswer = finalAnswer;
      const sourceMap = new Map<string, number>();
      let sourceCounter = 1;
      let citationInstanceCounter = 0;
      
      citations.forEach(citation => {
        if (!sourceMap.has(citation.source_file)) {
          sourceMap.set(citation.source_file, sourceCounter++);
        }
      });
      
      const replacementPattern = /\[SOURCE: ([^\]]+)\]/g;
      processedAnswer = processedAnswer.replace(replacementPattern, (fullMatch: string, sourceInfo: string) => {
        const parts = sourceInfo.split(', ');
        const sourceFile = parts[0];
        const sourceNumber = sourceMap.get(sourceFile) || 1;
        const instanceId = citationInstanceCounter++;
        return `<sup data-citation-instance="${instanceId}">[${sourceNumber}]</sup>`;
      });
      
      citations.forEach((citation) => {
        if (citation.highlight_phrases && citation.highlight_phrases.length > 0) {
          citation.highlight_phrases.forEach(phrase => {
            const regex = new RegExp(`\\b(${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'gi');
            processedAnswer = processedAnswer.replace(regex, '<mark class="bg-muted text-foreground font-semibold rounded px-1 py-0.5">$1</mark>');
          });
        }
      });
      
      return processedAnswer;
    }
  }