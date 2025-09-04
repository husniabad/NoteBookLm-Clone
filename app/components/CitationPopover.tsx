'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2 } from 'lucide-react';
import Highlighter from 'react-highlight-words';

interface Citation {
  source_file: string;
  page_number?: number;
  content_snippet: string;
  blob_url?: string;
  full_content?: string;
  quoted_chunks?: string[];
  specific_content?: string;
  chunk_id?: number;
  citation_id?: string;
  citation_index?: number;
}

interface CitationPopoverProps {
  citation: Citation;
  children: React.ReactNode;
}

interface PreviewCache {
  [key: string]: {
    fullContent: string;
    highlightPhrases: string[];
  };
}

declare global {
  interface Window {
    previewCache?: PreviewCache;
  }
}

export default function CitationPopover({ citation, children }: CitationPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [imageLoading, setImageLoading] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [cachedContent, setCachedContent] = useState<{ fullContent: string; highlightPhrases: string[] } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [popupWidth, setPopupWidth] = useState(320);
  const [popupHeight, setPopupHeight] = useState(200);
  const popupRef = useRef<HTMLDivElement>(null);
  

  
  // Global cache for preview data - use unique citation ID
  const getCacheKey = () => {
    return citation.citation_id || `${citation.chunk_id}-${citation.content_snippet?.substring(0, 50)}`;
  };
  
  useEffect(() => {
    const cacheKey = getCacheKey();
    const cached = window.previewCache?.[cacheKey];
    if (cached) {
      setCachedContent(cached);
    }
  }, []);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const handleMouseEnter = (e: React.MouseEvent) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setMousePos({ x: e.clientX, y: e.clientY });
    
    const showPopup = async () => {
      if (triggerRef.current) {
        // Find the message bubble for positioning constraints
        const messageContainer = triggerRef.current.closest('[class*="p-3"][class*="rounded-lg"]');
        const bubbleRect = messageContainer?.getBoundingClientRect();
        
        // Use actual bubble width
        const bubbleWidth = bubbleRect ? bubbleRect.width : 320;
        setPopupWidth(bubbleWidth * 0.9);
        
        const bubbleHeight = bubbleRect ? bubbleRect.height : 200;
        
        const isImage = citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i);
        const maxPopupHeight = Math.min(bubbleHeight, window.innerHeight * 0.6);
        const calculatedHeight = isImage ? Math.max(150, maxPopupHeight) : maxPopupHeight;
        setPopupHeight(calculatedHeight);
        const margin = 12;
        const offset = 8;
        
        // Get current mouse position
        const mouseX = mousePos.x || e.clientX;
        const mouseY = mousePos.y || e.clientY;
        
        // Horizontal positioning - constrain within bubble bounds
        let x;
        if (isImage) {
          // For images: position within bubble bounds
          const bubbleLeft = bubbleRect ? bubbleRect.left : margin;
          const bubbleRight = bubbleRect ? bubbleRect.right : window.innerWidth - margin;
          x = Math.max(bubbleLeft, Math.min(mouseX + offset, bubbleRight - 200));
        } else {
          // For text: center horizontally within bubble
          const bubbleLeft = bubbleRect ? bubbleRect.left : margin;
          const bubbleRight = bubbleRect ? bubbleRect.right : window.innerWidth - margin;
          const bubbleCenter = (bubbleLeft + bubbleRight) / 2;
          const popupWidthForCalc = bubbleWidth * 0.9;
          
          x = bubbleCenter - popupWidthForCalc / 2;
        }
        
        // Vertical positioning - force within bubble bounds
        const bubbleTop = bubbleRect ? bubbleRect.top : margin;
        const bubbleBottom = bubbleRect ? bubbleRect.bottom : window.innerHeight - margin;
        
        let y = mouseY + offset; // Start below cursor
        
        // Force within bubble bounds
        if (y + calculatedHeight > bubbleBottom) {
          y = bubbleBottom - calculatedHeight;
        }
        if (y < bubbleTop) {
          y = bubbleTop;
        }
        
        setPosition({ x, y });
        setIsOpen(true);
        
        // Check cache first
        const cacheKey = getCacheKey();
        const cached = window.previewCache?.[cacheKey];
        if (cached) {
          setCachedContent(cached);
          return;
        }
        
        setIsLoading(true);
        
             
        // Fetch content from preview API
        try {
          const response = await fetch('/api/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              blobUrl: citation.blob_url,
              sourceFile: citation.source_file,
              contextSnippet: citation.content_snippet,
              pageNumber: citation.page_number,
              specificContent: citation.specific_content
            })
          });
          
          if (response.ok) {
            const data = await response.json();
            const content = {
              fullContent: data.fullContent,
              highlightPhrases: data.highlightPhrases
            };
            
            // Cache the content
            if (!window.previewCache) {
              window.previewCache = {};
            }
            window.previewCache[cacheKey] = content;
            
            setCachedContent(content);
          }
        } catch (error) {
          console.error(`Failed to fetch preview for chunk ${citation.chunk_id}:`, error);
        } finally {
          setIsLoading(false);
        }
      }
    };
    
    // Disable cache temporarily for testing
    timeoutRef.current = setTimeout(showPopup, 500);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 300);
  };


  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const renderPopup = () => {
    if (!isOpen) return null;
    
    return createPortal(
      <div
        ref={popupRef}
        className="fixed z-50 bg-card text-card-foreground border rounded-lg shadow-xl max-h-[80vh] flex flex-col"
        style={{
          left: position.x,
          top: position.y,
          width: citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'auto' : `${popupWidth}px`,
          minWidth: citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? '0' : 'auto',
          height: citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? `${popupHeight}px` : 'auto',
          maxWidth: citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'none' : `${popupWidth}px`
        }}
        onMouseEnter={() => {
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
        }}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex justify-end p-2">
          <button 
            onClick={() => setIsOpen(false)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        
        <div className={`overflow-auto ${
          citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'p-1 h-full' : 'flex-1 p-4'
        }`}>
          {citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
            <div className="relative h-full" style={{ width: 'auto', minWidth: '0' }}>
              {citation.blob_url ? (
                <>
                  {imageLoading && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img 
                    src={citation.blob_url} 
                    alt={citation.source_file}
                    className="h-full w-auto object-contain rounded block mx-auto"
                    onLoad={() => setImageLoading(false)}
                    onError={() => setImageLoading(false)}
                    style={{ display: imageLoading ? 'none' : 'block' }}
                  />
                </>
              ) : (
                <span className="text-muted-foreground">Image preview not available</span>
              )}
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Loading preview...</span>
            </div>
          ) : cachedContent ? (
            <div className="overflow-auto whitespace-pre-wrap text-sm leading-relaxed" style={{ maxHeight: `${popupHeight - 100}px` }}>
              <Highlighter
                highlightClassName="bg-muted text-foreground font-semibold rounded px-1 py-0.5"
                searchWords={cachedContent.highlightPhrases}
                autoEscape={true}
                textToHighlight={cachedContent.fullContent}
                caseSensitive={false}
              />
            </div>
          ) : (
            <div className="text-center text-muted-foreground">
              <span>Preview not available</span>
            </div>
          )}
        </div>
        
        <div className={`flex items-center justify-center border-t bg-muted/20 ${
          citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'p-2' : 'p-3'
        }`}>
          {citation.blob_url ? (
            <a 
              href={citation.blob_url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              {citation.source_file}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">{citation.source_file}</span>
          )}
          {citation.page_number && (
            <span className="text-xs text-muted-foreground ml-2">
              • {citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) 
                ? '' 
                : citation.source_file.match(/\.(txt|md)$/i) 
                  ? 'Text File' 
                  : `Page ${citation.page_number}`
              }
            </span>
          )}
        </div>
      </div>,
      document.body
    );
  };

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseMove={(e) => setMousePos({ x: e.clientX, y: e.clientY })}
        className="inline-block"
      >
        {children}
      </span>
      {renderPopup()}
    </>
  );
}