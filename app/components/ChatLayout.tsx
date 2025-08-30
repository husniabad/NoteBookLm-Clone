'use client';

import { useState, useRef, FormEvent, useEffect, ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import { useChat } from 'ai/react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import Messages from './Messages';
import Textarea from 'react-textarea-autosize';
import { Paperclip, XCircle, Loader2 } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';

const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'image/png',
  'image/jpeg',
];

export default function ChatLayout() {
  const [files, setFiles] = useState<File[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const [rejectionMessage, setRejectionMessage] = useState('');

  const { messages, input, handleInputChange, handleSubmit, setMessages, isLoading } = useChat({
    api: '/api/chat',
    body: { sessionId },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);


  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // --- NEW POLLING FUNCTION ---
  // This function repeatedly asks our new '/api/upload/status' endpoint if processing is done.
  const pollForProcessingCompletion = async (sId: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        try {
          const response = await fetch('/api/upload/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sId }),
          });
          if (!response.ok) throw new Error('Status check failed');
          
          const data = await response.json();
          if (data.status === 'complete') {
            clearInterval(interval);
            resolve(true);
          }
        } catch (error) {
          console.error('Polling error:', error);
          clearInterval(interval);
          resolve(false); // Resolve false on error
        }
      }, 2000); // Check every 2 seconds
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
    }
    if (e.target) e.target.value = '';
  };

  const handleRemoveFile = (index: number) => {
    setFiles(prevFiles => prevFiles.filter((_, i) => i !== index));
  };

  const handleNewChat = () => {
    setMessages([]);
    setFiles([]);
    setSessionId(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // --- UPDATED SUBMISSION LOGIC WITH POLLING ---
  const customHandleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setRejectionMessage('');
    
    let currentSessionId = sessionId;
    if (!currentSessionId && (files.length > 0 || input.trim() !== '')) {
      currentSessionId = crypto.randomUUID();
      setSessionId(currentSessionId);
    }
    const finalSessionId = currentSessionId!;

    let textToSend = input;

    if (files.length > 0) {
      setIsUploading(true);
      setUploadMessage('Uploading files...');
      const formData = new FormData();
      files.forEach(file => formData.append('files', file));
      formData.append('sessionId', finalSessionId);

      try {
        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });
        if (!uploadResponse.ok) throw new Error('File upload failed');

        setUploadMessage('Processing files, please wait...');
        // Start polling and wait for it to complete
        await pollForProcessingCompletion(finalSessionId);

        setUploadMessage('Processing complete!');
        setFiles([]);
      } catch (error) {
        console.error("Upload error:", error);
        setUploadMessage('Upload failed. Please try again.');
        setIsUploading(false);
        return;
      } finally {
        setIsUploading(false);
        setTimeout(() => setUploadMessage(''), 3000);
      }
    }
    
    // Send the chat message only if there is text
    if (textToSend.trim() !== '') {
        handleSubmit(e, { options: { body: { sessionId: finalSessionId } } });
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
    // ... JSX remains the same ...
    <div
      className={`flex flex-col h-screen bg-secondary ${isDragOver ? 'border-2 border-dashed border-primary' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
      onDrop={handleDrop}>
      <header className='flex justify-between items-center p-4 border-b bg-background'>
        <h1 className='text-2xl font-bold'>RAG Chat</h1>
        <div className="flex items-center gap-4">
          <Button variant='outline' onClick={handleNewChat}>New Chat</Button>
          <ThemeToggle />
        </div>
      </header>
      <main className='flex-1 overflow-y-auto p-4'>
        <Messages messages={messages} />
        {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="flex justify-start">
            <div className="p-3 rounded-lg bg-card text-card-foreground">
              <div className="flex items-center justify-center space-x-1 h-5">
                <span className="h-2 w-2 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                <span className="h-2 w-2 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                <span className="h-2 w-2 bg-muted-foreground rounded-full animate-bounce"></span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>
      <footer className='p-4 bg-background border-t'>
        {rejectionMessage && <p className="text-sm text-center text-destructive mb-2">{rejectionMessage}</p>}
        {uploadMessage && <p className="text-sm text-center text-muted-foreground mb-2">{uploadMessage}</p>}
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
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder='Type a message or drop files...'
                  rows={1}
                  maxRows={5} 
                  className="flex-1 w-full resize-none bg-transparent p-0 border-0 focus:ring-0 focus:outline-none"
                  disabled={formIsDisabled}
                />
                <Button type='submit' disabled={formIsDisabled || (!input.trim() && files.length === 0)}>
                  {isUploading || isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </footer>
    </div>
  );
};