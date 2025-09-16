import React, { useState } from 'react';
import { Copy } from 'lucide-react';

interface Span {
  text: string;
  font: string;
  size: number;
  color: string;
  is_bold: boolean;
  is_italic: boolean;
  is_line_end: boolean;
}

interface ContentBlock {
  type: string;
  bounding_box: [number, number, number, number];
  spans?: Span[];
  html_content?: string;
  content?: string;
  url?: string;
  description?: string;
  source_image_url?: string;
}

interface PageData {
  page_number: number;
  page_dimensions: { width: number; height: number };
  content_blocks: ContentBlock[];
}

interface CitationBlueprintProps {
  pageData: PageData;
  className?: string;
}

export default function CitationBlueprint({ pageData, className = "" }: CitationBlueprintProps) {
  const { page_dimensions, content_blocks } = pageData;
  const [ocrTooltips, setOcrTooltips] = useState<{[key: number]: boolean}>({});
  const [showToast, setShowToast] = useState(false);
  
  if (!page_dimensions || !content_blocks) {
    return <div className="text-center text-gray-500 p-4">No blueprint data available</div>;
  }
  
  const isFullscreen = className.includes('h-full');
  const maxHeight = isFullscreen ? window.innerHeight - 100 : 400;
  const scale = page_dimensions.height > 0 ? maxHeight / page_dimensions.height : 1;
  
  const scaledWidth = page_dimensions.width * scale;
  const scaledHeight = page_dimensions.height * scale;

  const renderBlock = (block: ContentBlock, index: number) => {
    const [x0, y0, x1, y1] = block.bounding_box;
    const baseStyle = {
      position: 'absolute' as const,
      left: `${x0 * scale}px`,
      top: `${y0 * scale}px`,
      width: `${(x1 - x0) * scale}px`,
      backgroundColor: 'white',
    };

    switch (block.type) {
      case 'text':
        const blockWidth = (x1 - x0) * scale;
        const blockHeight = (y1 - y0) * scale;
        const lines = block.spans?.reduce((acc: Span[][], span: Span, i: number) => {
          if (i === 0 || block.spans![i-1]?.is_line_end) acc.push([]);
          acc[acc.length - 1].push(span);
          return acc;
        }, [] as Span[][]) || [];
        
        const sizeRatios: {[key: number]: number} = {};
        lines.forEach((lineSpans: Span[]) => {
          const lineText = lineSpans.map(s => s.text).join('');
          const avgSize = lineSpans.reduce((sum, s) => sum + s.size, 0) / lineSpans.length;
          const baseSize = avgSize * scale;
          const estimatedWidth = lineText.length * baseSize * 0.6;
          const widthScale = estimatedWidth > blockWidth ? blockWidth / estimatedWidth : 1;
          const heightScale = blockHeight / lines.length * 0.8 / baseSize;
          const ratio = Math.min(widthScale, heightScale);
          
          if (!sizeRatios[avgSize] || ratio < sizeRatios[avgSize]) {
            sizeRatios[avgSize] = ratio;
          }
        });
        
        return (
          <div key={index} style={{...baseStyle, height: `${blockHeight}px`, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'space-evenly'}}>
            {lines.map((lineSpans: Span[], lineIndex: number) => {
              const avgSize = lineSpans.reduce((sum, s) => sum + s.size, 0) / lineSpans.length;
              const baseSize = avgSize * scale;
              const finalSize = baseSize * sizeRatios[avgSize];
              
              return (
                <div key={lineIndex} style={{fontSize: `${finalSize}pt`, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden'}}>
                  {lineSpans.map((span: Span, spanIndex: number) => {
                    const urlRegex = /(https?:\/\/[^\s]+)/g;
                    const parts = span.text.split(urlRegex);
                    
                    return (
                      <span
                        key={spanIndex}
                        style={{
                          fontFamily: span.font,
                          color: span.color,
                          fontWeight: span.is_bold ? 'bold' : 'normal',
                          fontStyle: span.is_italic ? 'italic' : 'normal',
                        }}
                      >
                        {parts.map((part, partIndex) => 
                          urlRegex.test(part) ? (
                            <a key={partIndex} href={part} target="_blank" rel="noopener noreferrer" style={{color: 'blue', textDecoration: 'underline'}}>
                              {part}
                            </a>
                          ) : part
                        )}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      
      case 'header_footer_text':
        return (
          <div
            key={index}
            style={{
              ...baseStyle,
              height: `${(y1 - y0) * scale}px`,
              overflow: 'hidden',
              fontSize: `${8 * scale}pt`,
              lineHeight: 1.2,
              color: 'black',
            }}
          >
            {block.content}
          </div>
        );
      
      case 'ocr_text_block':
        const ocrText = block.html_content?.replace(/<[^>]*>/g, '') || '';
        const showTooltip = ocrTooltips[index] || false;
        return (
          <div key={index} style={{...baseStyle, height: `${(y1 - y0) * scale}px`, overflow: 'hidden', position: 'relative'}}>
            {block.source_image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={block.source_image_url}
                alt="OCR content"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <div
                style={{
                  backgroundColor: 'rgba(254, 243, 199, 0.95)',
                  color: '#92400e',
                  fontSize: `${10 * scale}px`,
                  padding: `${2 * scale}px`,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <p style={{ margin: 0 }}>{ocrText}</p>
              </div>
            )}
            <div
              style={{
                position: 'absolute',
                bottom: '4px',
                right: '4px',
                opacity: showTooltip ? 1 : 0.25,
                cursor: 'pointer',
                backgroundColor: 'white',
                borderRadius: '4px',
                padding: '2px',
                fontSize: '12px'
              }}
              onMouseEnter={() => setOcrTooltips(prev => ({...prev, [index]: true}))}
              onMouseLeave={() => setOcrTooltips(prev => ({...prev, [index]: false}))}
              onClick={() => {
                navigator.clipboard.writeText(ocrText);
                setShowToast(true);
                setTimeout(() => setShowToast(false), 2000);
              }}
              title={showTooltip ? ocrText : ''}
            >
              <Copy size={12} color="#333" />
            </div>
          </div>
        );
      
      case 'image':
      case 'vector':
        const imageText = block.description || 'Visual content';
        const showImageTooltip = ocrTooltips[index] || false;
        return (
          <div key={index} style={{...baseStyle, height: `${(y1 - y0) * scale}px`, overflow: 'hidden', position: 'relative'}}>
            {block.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={block.url}
                alt={imageText}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <div style={{ 
                color: '#1e40af', 
                fontSize: `${10 * scale}px`, 
                textAlign: 'center',
                padding: `${4 * scale}px`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(219, 234, 254, 0.95)',
                height: '100%'
              }}>
                📊 {imageText.substring(0, 30)}...
              </div>
            )}
            <div
              style={{
                position: 'absolute',
                bottom: '4px',
                right: '4px',
                opacity: showImageTooltip ? 1 : 0.25,
                cursor: 'pointer',
                backgroundColor: 'white',
                borderRadius: '4px',
                padding: '2px',
                fontSize: '12px'
              }}
              onMouseEnter={() => setOcrTooltips(prev => ({...prev, [index]: true}))}
              onMouseLeave={() => setOcrTooltips(prev => ({...prev, [index]: false}))}
              onClick={() => {
                navigator.clipboard.writeText(imageText);
                setShowToast(true);
                setTimeout(() => setShowToast(false), 2000);
              }}
              title={showImageTooltip ? imageText : ''}
            >
              <Copy size={12} color="#333" />
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className={`relative ${isFullscreen ? '' : 'bg-gray-50'} border p-2 ${className}`} style={{height: 'auto', width: 'auto'}}>
      <div
        style={{
          width: `${scaledWidth}px`,
          height: `${scaledHeight}px`,
          position: 'relative',
          margin: '0 auto',
          backgroundColor: '#ffffff',
        }}
      >
        {content_blocks.map((block, index) => renderBlock(block, index))}
      </div>
      {showToast && (
        <div style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          backgroundColor: '#10b981',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '6px',
          fontSize: '14px',
          zIndex: 1000
        }}>
          Copied to clipboard!
        </div>
      )}
    </div>
  );
}