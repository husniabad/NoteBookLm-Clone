import genAI from './ai-provider';

export interface TableData {
  headers: string[];
  rows: string[][];
  caption?: string;
}

export interface ChartData {
  type: string;
  values: { [key: string]: number | string };
  title?: string;
}

export interface PageStructure {
  pageNumber: number;
  sections: string[];
  tables: TableData[];
  charts: ChartData[];
  entities: string[];
}

export async function extractStructuredData(visualAnalysis: string, pageNumber: number): Promise<PageStructure> {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  
  const prompt = `Extract structured data from this page analysis:

Page ${pageNumber} Analysis: ${visualAnalysis}

Return JSON with:
{
  "pageNumber": ${pageNumber},
  "sections": ["section titles/headers found"],
  "tables": [{"headers": ["col1", "col2"], "rows": [["val1", "val2"]], "caption": "table title"}],
  "charts": [{"type": "bar|pie|line", "values": {"label": "value"}, "title": "chart title"}],
  "entities": ["people", "companies", "locations mentioned"]
}

Extract actual data values from tables and charts when visible.`;

  try {
    if (!model.generateContent) {
          throw new Error('Vision model does not support generateContent');
        }
    const result = await model.generateContent([prompt]);
    const parsed = JSON.parse(result?.response?.text() || '{}');
    return {
      pageNumber,
      sections: parsed.sections || [],
      tables: parsed.tables || [],
      charts: parsed.charts || [],
      entities: parsed.entities || []
    };
  } catch {
    return { pageNumber, sections: [], tables: [], charts: [], entities: [] };
  }
}

export function correlateTextWithVisuals(textContent: string, visualAnalysis: string): string[] {
  const correlations: string[] = [];
  
  // Find references to figures, tables, charts
  const figureRefs = textContent.match(/(?:figure|fig|table|chart|diagram)\s*\d+/gi) || [];
  const visualMentions = textContent.match(/(?:shown|depicted|illustrated|displayed)\s+(?:in|above|below)/gi) || [];
  
  figureRefs.forEach(ref => {
    if (visualAnalysis.toLowerCase().includes(ref.toLowerCase().replace(/\s+/g, ' '))) {
      correlations.push(`Text reference "${ref}" correlates with visual content`);
    }
  });
  
  visualMentions.forEach(mention => {
    correlations.push(`Text contains visual reference: "${mention}"`);
  });
  
  return correlations;
}

export function assembleMultiPageContent(pages: Array<{content: string, pageNumber: number}>): Array<{content: string, pageNumbers: number[]}> {
  const assembled: Array<{content: string, pageNumbers: number[]}> = [];
  
  for (let i = 0; i < pages.length; i++) {
    const currentPage = pages[i];
    let assembledContent = currentPage.content;
    const pageNumbers = [currentPage.pageNumber];
    
    // Check if content continues on next page
    if (i < pages.length - 1) {
      const nextPage = pages[i + 1];
      
      // Simple heuristic: if current page ends mid-sentence and next starts continuing
      const endsIncomplete = !currentPage.content.trim().match(/[.!?]$/);
      const nextStartsContinuation = nextPage.content.trim().match(/^[a-z]/);
      
      if (endsIncomplete && nextStartsContinuation) {
        assembledContent += ' ' + nextPage.content;
        pageNumbers.push(nextPage.pageNumber);
        i++; // Skip next page as it's been merged
      }
    }
    
    assembled.push({ content: assembledContent, pageNumbers });
  }
  
  return assembled;
}