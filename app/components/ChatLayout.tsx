'use client';

import { useState, useRef, FormEvent, useEffect, ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import Textarea from 'react-textarea-autosize';
import { Paperclip, XCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';
import ReactMarkdown from 'react-markdown';

const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'image/png',
  'image/jpeg',
];

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
}

export default function ChatLayout() {
  const [files, setFiles] = useState<File[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [rejectionMessage, setRejectionMessage] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isWaitingResponse, setIsWaitingResponse] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Scroll to latest user message when it's added
    const latestUserMessage = messages.find(msg => msg.isLatestUserMessage);
    if (latestUserMessage) {
      setTimeout(() => {
        const element = document.querySelector(`[data-message-id="${latestUserMessage.id}"]`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    }
  }, [messages]);

  const pollForProcessingCompletion = async (sId: string): Promise<boolean> => {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 30;
      
      const interval = setInterval(async () => {
        attempts++;
        
        try {
          const response = await fetch('/api/upload/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sId }),
          });
          if (!response.ok) throw new Error('Status check failed');
          
          const data = await response.json();
          
          if (data.status === 'complete' || attempts >= maxAttempts) {
            clearInterval(interval);
            resolve(data.status === 'complete');
          }
        } catch (error) {
          console.error('Polling error:', error);
          clearInterval(interval);
          resolve(false);
        }
      }, 2000);
    });
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setRejectionMessage('');
    const selectedFiles = Array.from(e.target.files || []);
    const validFiles = selectedFiles.filter(file => ALLOWED_FILE_TYPES.includes(file.type));
    
    if (validFiles.length < selectedFiles.length) {
      setRejectionMessage('Unsupported file types were ignored.');
    }
    if (validFiles.length > 0) {
      setFiles(prevFiles => [...prevFiles, ...validFiles]);
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
    if (e.target) e.target.value = '';
  };

  const handleRemoveFile = (index: number) => {
    setFiles(prevFiles => prevFiles.filter((_, i) => i !== index));
  };

  const handleNewChat = () => {
    setMessages([]);
    setFiles([]);
    setRejectionMessage('');
    setInputValue('');
    setSessionId(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const addMessageWithProgress = (content: string, attachedFiles: File[], status: 'uploading' | 'processing' | 'complete') => {
    const message: Message = {
      id: Date.now(),
      role: 'user',
      content,
      files: attachedFiles.map(f => ({ name: f.name, type: f.type, size: f.size })),
      status,
      isLatestUserMessage: true
    };
    setMessages(prev => {
      // Mark all previous messages as not latest
      const updated = prev.map(msg => ({ ...msg, isLatestUserMessage: false }));
      return [...updated, message];
    });
    setIsWaitingResponse(true);
    return message.id;
  };

  const updateMessageProgress = (id: number, status: 'uploading' | 'processing' | 'complete') => {
    setMessages(prev => prev.map(msg => 
      msg.id === id ? { ...msg, status } : msg
    ));
  };

  const customHandleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setRejectionMessage('');
    
    const textToSend = inputValue.trim();
    const currentFiles = [...files];
    
    if (!textToSend && currentFiles.length === 0) return;

    // Generate session ID if needed
    let currentSessionId = sessionId;
    if (!currentSessionId && (currentFiles.length > 0 || textToSend)) {
      currentSessionId = crypto.randomUUID();
      setSessionId(currentSessionId);
    }

    // Clear input immediately
    setInputValue('');
    setFiles([]);

    // Case 1: File-Only Upload
    if (currentFiles.length > 0 && !textToSend) {
      const messageId = addMessageWithProgress('', currentFiles, 'uploading');
      
      // Scroll to top immediately after adding user message
      setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 50);
      
      setIsUploading(true);

      const formData = new FormData();
      currentFiles.forEach(file => formData.append('files', file));
      formData.append('sessionId', currentSessionId!);

      try {
        const uploadResponse = await fetch('/api/upload/start', {
          method: 'POST',
          body: formData,
        });
        if (!uploadResponse.ok) throw new Error('File upload failed');

        updateMessageProgress(messageId, 'processing');
        await pollForProcessingCompletion(currentSessionId!);
        
        // Show analysis message immediately for file-only case
        setMessages(prev => prev.map(msg => 
          msg.id === messageId ? { ...msg, status: 'analysis' } : msg
        ));
      } catch (error) {
        console.error("Upload error:", error);
        updateMessageProgress(messageId, 'complete');
      } finally {
        setIsUploading(false);
      }
      return;
    }

    // Case 2: File + Text
    if (currentFiles.length > 0 && textToSend) {
      const messageId = addMessageWithProgress(textToSend, currentFiles, 'uploading');
      
      // Scroll to top immediately after adding user message
      setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 50);
      
      setIsUploading(true);

      const formData = new FormData();
      currentFiles.forEach(file => formData.append('files', file));
      formData.append('sessionId', currentSessionId!);

      try {
        const uploadResponse = await fetch('/api/upload/start', {
          method: 'POST',
          body: formData,
        });
        if (!uploadResponse.ok) throw new Error('File upload failed');

        updateMessageProgress(messageId, 'processing');
        await pollForProcessingCompletion(currentSessionId!);
        updateMessageProgress(messageId, 'complete');
        
        // Now proceed with chat using streaming (skip user message since we already have it)
        await handleChatMessage(textToSend, currentSessionId!, true);
        
      } catch (error) {
        console.error("Upload error:", error);
        updateMessageProgress(messageId, 'complete');
      } finally {
        setIsUploading(false);
      }
      return;
    }

    // Case 3: Text-Only Message
    if (textToSend && currentFiles.length === 0) {
      await handleChatMessage(textToSend, currentSessionId!);
    }
  };

  const handleChatMessage = async (text: string, sId: string, skipUserMessage = false) => {
    // Add user message only if not skipped (for file+text case)
    if (!skipUserMessage) {
      const userMessage: Message = {
        id: Date.now(),
        role: 'user',
        content: text,
        isLatestUserMessage: true
      };
      setMessages(prev => {
        // Mark all previous messages as not latest
        const updated = prev.map(msg => ({ ...msg, isLatestUserMessage: false }));
        return [...updated, userMessage];
      });
      setIsWaitingResponse(true);
    }

    // Add thinking message
    const thinkingId = Date.now() + 1;
    const thinkingMessage: Message = {
      id: thinkingId,
      role: 'assistant',
      content: '',
      searchSteps: [],
      isThinking: true,
      currentStep: 'Starting...',
      isExpanded: false
    };
    setMessages(prev => [...prev, thinkingMessage]);

    setIsLoading(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: sId }),
      });

      if (!response.ok) throw new Error('Chat request failed');
      
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ') && line.slice(6).trim()) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.type === 'thinking') {
                setMessages(prev => prev.map(msg => 
                  msg.id === thinkingId ? {
                    ...msg,
                    currentStep: data.step,
                    searchSteps: [...(msg.searchSteps || []), data.step]
                  } : msg
                ));
              } else if (data.type === 'response') {
                // Update message with final response, keep thinking collapsed
                setMessages(prev => prev.map(msg => 
                  msg.id === thinkingId ? {
                    ...msg,
                    content: data.response,
                    searchSteps: data.searchSteps,
                    isComplex: data.isComplex,
                    isThinking: false,
                    isExpanded: false,
                    currentStep: undefined
                  } : msg
                ));
                setIsWaitingResponse(false);
              }
            } catch (e) {
              console.error('Error parsing SSE data:', e);
            }
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => prev.map(msg => 
        msg.id === thinkingId ? {
          ...msg,
          content: 'Sorry, an error occurred while processing your request.',
          isThinking: false,
          isExpanded: false,
          currentStep: undefined
        } : msg
      ));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    setRejectionMessage('');
    const droppedFiles = Array.from(e.dataTransfer.files || []);
    const validFiles = droppedFiles.filter(file => ALLOWED_FILE_TYPES.includes(file.type));

    if (validFiles.length < droppedFiles.length) {
      setRejectionMessage('Unsupported file types were ignored.');
    }
    if (validFiles.length > 0) {
      setFiles(prevFiles => [...prevFiles, ...validFiles]);
    }
    e.dataTransfer.clearData();
  };
  
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const formIsDisabled = isUploading || isLoading;

  return (
    <div
      className={`flex flex-col h-screen bg-secondary ${isDragOver ? 'border-2 border-dashed border-primary' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
      onDrop={handleDrop}>
      <header className='flex justify-between items-center p-4 border-b bg-background'>
        <h1 className='text-2xl font-bold'>DocuChat</h1>
        <div className="flex items-center gap-4">
          <Button variant='outline' onClick={handleNewChat}>New Chat</Button>
          <ThemeToggle />
        </div>
      </header>
      <main className='flex-1 overflow-y-auto p-4'>
        {messages.map((message) => (
          <div key={message.id} data-message-id={message.id} className={`mb-4 ${message.role === 'user' ? 'flex justify-end' : 'flex justify-start'} ${
            message.isLatestUserMessage ? 'scroll-mt-4' : ''
          }`}>
            <div className={`max-w-3xl p-3 rounded-lg ${
              message.role === 'user' 
                ? 'bg-primary text-primary-foreground' 
                : 'bg-card text-card-foreground border'
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
                        {message.status === 'analysis' && 'Files uploaded, starting analysis...'}
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
                          onClick={() => {
                            setMessages(prev => prev.map(msg => 
                              msg.id === message.id ? { ...msg, isExpanded: !msg.isExpanded } : msg
                            ));
                          }}
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
                              onClick={() => {
                                setMessages(prev => prev.map(msg => 
                                  msg.id === message.id ? { ...msg, isExpanded: !msg.isExpanded } : msg
                                ));
                              }}
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
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        ))}

        {/* Spacer to keep latest message at top while waiting for response */}
        {isWaitingResponse && (
          <div className="h-96"></div>
        )}
        <div ref={messagesEndRef} />
      </main>
      <footer className='p-4 bg-background border-t'>
        {rejectionMessage && <p className="text-sm text-center text-destructive mb-2">{rejectionMessage}</p>}

        <div className="relative">
          <form onSubmit={customHandleSubmit} ref={formRef}>
            <div className="w-full border rounded-lg p-2 flex flex-col focus-within:ring-2 focus-within:ring-ring bg-background">
              <div className="flex flex-wrap gap-2 mb-2 px-2">
                {files.map((file, index) => (
                  <div key={index} className='flex items-center bg-secondary text-secondary-foreground py-1 px-2 rounded-md'>
                    <span className='text-sm truncate max-w-xs'>{file.name}</span>
                    <Button variant='ghost' size='icon' onClick={() => handleRemoveFile(index)} className="h-6 w-6 ml-2" disabled={formIsDisabled}>
                      <XCircle className='h-4 w-4' />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center space-x-2">
                <Button type='button' variant='ghost' size='icon' onClick={() => fileInputRef.current?.click()} disabled={formIsDisabled}>
                  <Paperclip className='h-5 w-5' />
                </Button>
                <Input 
                  type='file' 
                  ref={fileInputRef} 
                  onChange={handleFileChange} 
                  className='hidden' 
                  multiple 
                  disabled={formIsDisabled}
                  accept={ALLOWED_FILE_TYPES.join(',')}
                />
                <Textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder='Type a message or drop PDFs, images, text files...'
                  rows={1}
                  maxRows={5} 
                  className="flex-1 w-full resize-none bg-transparent p-0 border-0 focus:ring-0 focus:outline-none"
                  disabled={formIsDisabled}
                />
                <Button type='submit' disabled={formIsDisabled || (!inputValue.trim() && files.length === 0)}>
                  {isUploading || isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </footer>
    </div>
  );
}