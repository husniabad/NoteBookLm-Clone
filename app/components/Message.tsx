'use client';

import { Button } from './ui/button';
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';

import CitationPopover from './CitationPopover';

interface Citation {
  source_file: string;
  page_number?: number;
  content_snippet: string;
  blob_url?: string;
  full_content?: string;
  quoted_chunks?: string[];
  specific_content?: string;
  chunk_id?: number;
  citation_index?: number;
}

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  searchSteps?: string[];
  isComplex?: boolean;
  files?: { name: string; type: string; size: number }[];
  status?: 'uploading' | 'processing' | 'complete' | 'analysis';
  isThinking?: boolean;
  currentStep?: string;
  isExpanded?: boolean;
  isLatestUserMessage?: boolean;
  citations?: Citation[];
}

interface MessageProps {
  message: Message;
  onToggleExpanded: (messageId: number) => void;
}

export default function Message({ message, onToggleExpanded }: MessageProps) {


  return (
    <>
      <div className={`mb-4 ${message.role === 'user' ? 'flex justify-end' : 'flex justify-start'} ${
        message.isLatestUserMessage ? 'scroll-mt-4' : ''
      }`}>
        <div className={`p-3 rounded-lg ${
          message.role === 'user' 
            ? 'bg-primary text-primary-foreground max-w-[calc(100%-3rem)] md:max-w-[75%]' 
            : 'bg-card text-card-foreground border max-w-[calc(100%-1.5rem)] md:max-w-[85%]'
        }`}>
          {message.role === 'user' && (
            <>
              {message.content && <div>{message.content}</div>}
              {message.files && message.files.length > 0 && (
                <div className="mt-2 text-sm opacity-80">
                  📎 {message.files.map(f => f.name).join(', ')}
                </div>
              )}
              {message.status && message.status !== 'complete' && (
                <div className="mt-2 flex items-center space-x-2 text-sm opacity-70">
                  {message.status !== 'analysis' && <Loader2 className="h-3 w-3 animate-spin" />}
                  <span>
                    {message.status === 'uploading' && 'Uploading...'}
                    {message.status === 'processing' && 'Processing...'}
                    {message.status === 'analysis' && 'Files uploaded, Start analysis now!'}
                  </span>
                </div>
              )}
            </>
          )}
          {message.role === 'assistant' && (
            <>
              {message.isThinking ? (
                <div className="w-full">
                  <div className="flex items-center justify-between p-2 bg-muted/30 rounded-t border">
                    <div className="flex items-center space-x-2 flex-1 min-w-0">
                      <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                      <span className="text-sm font-medium flex-shrink-0">Thinking...</span>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => onToggleExpanded(message.id)}
                      className="h-6 w-6 p-0 flex-shrink-0"
                    >
                      {message.isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </Button>
                  </div>
                  <div className="p-2 bg-muted/10 border-x border-b rounded-b">
                    <div className="text-sm text-muted-foreground truncate">
                      {message.currentStep}
                    </div>
                    <div className={`overflow-hidden transition-all duration-300 ease-in-out ${
                      message.isExpanded ? 'max-h-96 opacity-100 mt-2' : 'max-h-0 opacity-0'
                    }`}>
                      {message.searchSteps && message.searchSteps.length > 0 && (
                        <div className="p-2 bg-muted/50 rounded text-xs space-y-1">
                          {message.searchSteps.map((step, i) => (
                            <div key={i} className="text-muted-foreground">
                              {i === 0 && '🤔 '}
                              {i > 0 && i < message.searchSteps!.length - 1 && '🔍 '}
                              {i === message.searchSteps!.length - 1 && '✅ '}
                              {step}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {message.searchSteps && message.searchSteps.length > 0 && (
                    <div className="mb-3 w-full">
                      <div className="flex items-center justify-between p-2 bg-muted/30 rounded-t border">
                        <div className="font-medium truncate flex-1">
                          {message.isComplex ? '🧠 Complex Query Analysis' : '🔍 Search Process'}
                        </div>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => onToggleExpanded(message.id)}
                          className="h-6 w-6 p-0 flex-shrink-0"
                        >
                          {message.isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </Button>
                      </div>
                      <div className={`overflow-hidden transition-all duration-300 ease-in-out border-x border-b rounded-b bg-muted/10 ${
                        message.isExpanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
                      }`}>
                        <div className="p-2 space-y-1">
                          {message.searchSteps.map((step, i) => (
                            <div key={i} className="text-muted-foreground text-sm">
                              {i === 0 && '🤔 '}
                              {i > 0 && i < message.searchSteps!.length - 1 && '🔍 '}
                              {i === message.searchSteps!.length - 1 && '✅ '}
                              {step}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {message.content && (
                    <div className="prose max-w-none dark:prose-invert prose-sm">
                      <ReactMarkdown 
                        rehypePlugins={[rehypeRaw]}
                        components={{
                          sup: ({ children, ...props }: { children?: React.ReactNode; 'data-citation-instance'?: string }) => {
                            // Extract citation number and instance ID
                            const citationText = children?.toString() || '';
                            const match = citationText.match(/\[(\d+)\]/);
                            const citationNumber = match ? parseInt(match[1]) : 0;
                            const instanceId = props['data-citation-instance'] as string | undefined;
                            
                            // Find the specific citation by instance ID (order in array)
                            const targetCitation = instanceId !== undefined ? 
                              message.citations?.[parseInt(instanceId)] : 
                              message.citations?.[citationNumber - 1];
                            
                            
                            if (targetCitation) {
                              return (
                                <CitationPopover citation={targetCitation}>
                                  <span className="inline-flex items-center justify-center text-xs text-slate-600 bg-slate-600/40 hover:bg-slate-600/60 w-5 h-5 rounded-full ml-1 cursor-pointer transition-colors no-underline align-super">
                                    {citationNumber}
                                  </span>
                                </CitationPopover>

                              );
                            }
                            
                            return (
                              <span className="inline-flex items-center justify-center text-xs text-slate-600 bg-slate-600/40 w-5 h-5 rounded-full ml-1 align-super">
                                {citationNumber}
                              </span>
                            );
                          }
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  )}
                  {message.citations && message.citations.length > 0 && (() => {
                    // Group citations by source file
                    const groupedCitations = message.citations.reduce((acc, citation) => {
                      if (!acc[citation.source_file]) {
                        acc[citation.source_file] = {
                          source_file: citation.source_file,
                          blob_url: citation.blob_url,
                          full_content: citation.full_content,
                          pages: [],
                          content_snippets: []
                        };
                      }
                      if (citation.page_number) {
                        acc[citation.source_file].pages.push(citation.page_number);
                      }
                      acc[citation.source_file].content_snippets.push(citation.content_snippet);
                      return acc;
                    }, {} as Record<string, { source_file: string; blob_url?: string; full_content?: string; pages: number[]; content_snippets: string[] }>);

                    return (
                      <div className="mt-3 border-t pt-3">
                        <div className="text-sm font-medium text-muted-foreground mb-2">Sources:</div>
                        <div className="space-y-2">
                          {Object.values(groupedCitations).map((group, i) => {
                            const uniquePages = [...new Set(group.pages)].sort((a, b) => a - b);
                            return (
                              <div key={i} className="flex items-start space-x-2 text-xs bg-muted/30 p-2 rounded hover:bg-muted/50 transition-colors">
                                <span className="font-medium text-primary">[{i + 1}]</span>
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    {group.blob_url ? (
                                      <a 
                                        href={group.blob_url} 
                                        target="_blank" 
                                        rel="noopener noreferrer"
                                        className="font-medium text-blue-600 hover:text-blue-800 underline"
                                      >
                                        {group.source_file}
                                      </a>
                                    ) : (
                                      <span className="font-medium text-foreground">
                                        {group.source_file}
                                      </span>
                                    )}
                                    {group.blob_url && (
                                      <a 
                                        href={group.blob_url} 
                                        target="_blank" 
                                        rel="noopener noreferrer"
                                        className="text-muted-foreground hover:text-foreground"
                                        title="Preview file"
                                      >
                                        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                        </svg>
                                      </a>
                                    )}
                                  </div>
                                  {uniquePages.length > 0 && (
                                    <div className="text-muted-foreground">
                                      {group.source_file.match(/\.(jpg|jpeg|png|gif|webp)$/i) 
                                        ? 'Image' 
                                        : group.source_file.match(/\.(txt|md)$/i)
                                          ? 'Text File'
                                          : uniquePages.length === 1 ? `Page ${uniquePages[0]}` : `Pages ${uniquePages.join(', ')}`
                                      }
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </>
          )}
        </div>
      </div>




    </>
  );
}