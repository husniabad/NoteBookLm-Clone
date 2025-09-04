'use client';

import { useState } from 'react';
import { Button } from './ui/button';
import { X, Loader2 } from 'lucide-react';
import Highlighter from 'react-highlight-words';

interface Citation {
  source_file: string;
  page_number?: number;
  content_snippet: string;
  blob_url?: string;
  full_content?: string;
  quoted_chunks?: string[];
}

interface PreviewModalProps {
  citation: Citation;
  isOpen: boolean;
  onClose: () => void;
}

export default function PreviewModal({ citation, isOpen, onClose }: PreviewModalProps) {
  const [imageLoading, setImageLoading] = useState(true);
  
  if (!isOpen) return null;

  // Extract meaningful text for highlighting from content_snippet
  const getHighlightWords = (snippet: string) => {
    if (!snippet || snippet === 'Referenced content') {
      return [];
    }
    
    const words = [];
    
    // Extract text within single quotes
    const singleQuoted = snippet.match(/'([^']+)'/g);
    if (singleQuoted) {
      singleQuoted.forEach(match => {
        words.push(match.replace(/'/g, ''));
      });
    }
    
    // Extract text within double quotes  
    const doubleQuoted = snippet.match(/"([^"]+)"/g);
    if (doubleQuoted) {
      doubleQuoted.forEach(match => {
        words.push(match.replace(/"/g, ''));
      });
    }
    
    // If no quoted text found, extract meaningful phrases and words
    if (words.length === 0) {
      // Clean the snippet and split into meaningful chunks
      const cleanSnippet = snippet
        .replace(/[\[\](){}]/g, '') // Remove brackets
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
      
      // Split by sentences first, then by meaningful phrases
      const sentences = cleanSnippet.split(/[.!?]+/).filter(s => s.trim().length > 3);
      
      sentences.forEach(sentence => {
        const trimmed = sentence.trim();
        if (trimmed.length > 10) {
          // For longer sentences, add the whole sentence and key phrases
          words.push(trimmed);
          
          // Also add phrases of 3+ words
          const phrases = trimmed.split(/[,;:]/).filter(p => p.trim().split(' ').length >= 3);
          phrases.forEach(phrase => {
            const cleanPhrase = phrase.trim();
            if (cleanPhrase.length > 10) {
              words.push(cleanPhrase);
            }
          });
        } else if (trimmed.length > 3) {
          words.push(trimmed);
        }
      });
      
      // If still no good words, split by meaningful word groups
      if (words.length === 0) {
        const wordGroups = cleanSnippet.split(' ');
        for (let i = 0; i < wordGroups.length - 2; i++) {
          const phrase = wordGroups.slice(i, i + 3).join(' ');
          if (phrase.length > 8) {
            words.push(phrase);
          }
        }
        
        // Add individual significant words as fallback
        const significantWords = wordGroups.filter(word => 
          word.length > 4 && !/^(the|and|or|but|in|on|at|to|for|of|with|by)$/i.test(word)
        );
        words.push(...significantWords);
      }
    }
    
    // Remove duplicates and return unique words
    return [...new Set(words)].slice(0, 10); // Limit to 10 highlight terms
  };

  const highlightWords = citation.quoted_chunks && citation.quoted_chunks.length > 0 
    ? citation.quoted_chunks 
    : getHighlightWords(citation.content_snippet);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">{citation.source_file}</h2>
            {citation.page_number && (
              <p className="text-sm text-muted-foreground">Page {citation.page_number}</p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        
        <div className="flex-1 overflow-auto p-4">
          {citation.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
            <div className="relative w-full h-full flex items-center justify-center">
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
                    className="w-full h-full object-contain rounded"
                    onLoad={() => setImageLoading(false)}
                    onError={() => setImageLoading(false)}
                    style={{ display: imageLoading ? 'none' : 'block' }}
                  />
                </>
              ) : (
                <p className="text-muted-foreground">Image preview not available</p>
              )}
            </div>
          ) : citation.full_content ? (
            <div className="prose max-w-none dark:prose-invert prose-sm">
              <Highlighter
                highlightClassName="bg-yellow-200 dark:bg-yellow-800 rounded px-1 font-medium"
                searchWords={highlightWords}
                autoEscape={true}
                textToHighlight={citation.full_content}
                caseSensitive={false}
              />
            </div>
          ) : (
            <div className="text-center text-muted-foreground">
              <p>Preview not available</p>
              {citation.blob_url && (
                <Button 
                  variant="outline" 
                  className="mt-2"
                  onClick={() => window.open(citation.blob_url, '_blank')}
                >
                  Open Original File
                </Button>
              )}
            </div>
          )}
        </div>
        

      </div>
    </div>
  );
}