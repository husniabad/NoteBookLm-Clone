'use client';

import { useState, useCallback } from 'react';
import { useChat } from 'ai/react';
import { Message } from 'ai';

interface FileAttachment {
  name: string;
  type: string;
  size: number;
}

interface ExtendedMessage extends Message {
  attachments?: FileAttachment[];
  status?: 'sending' | 'uploading' | 'processing' | 'complete';
}

interface ProgressMessage {
  id: string;
  role: 'user';
  content: string;
  attachments: FileAttachment[];
  status: 'uploading' | 'processing' | 'complete';
  createdAt: Date;
}

export function useExtendedChat(options: { api: string; body?: Record<string, unknown> }) {
  const chatHook = useChat(options);
  const [progressMessages, setProgressMessages] = useState<ProgressMessage[]>([]);


  const allMessages: ExtendedMessage[] = [
    ...chatHook.messages,
    ...progressMessages
  ].sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return timeA - timeB;
  });

  const addMessageWithProgress = useCallback((content: string, attachments: FileAttachment[], status: string) => {
    const messageId = crypto.randomUUID();
    const progressMessage: ProgressMessage = {
      id: messageId,
      role: 'user',
      content,
      attachments,
      status: status as 'uploading' | 'processing' | 'complete',
      createdAt: new Date()
    };
    
    setProgressMessages(prev => [...prev, progressMessage]);
    return messageId;
  }, []);

  const updateMessageProgress = useCallback((id: string, status: string, content?: string) => {
    setProgressMessages(prev => prev.map(msg => 
      msg.id === id ? { 
        ...msg, 
        status: status as 'uploading' | 'processing' | 'complete',
        ...(content !== undefined && { content })
      } : msg
    ));
  }, []);

  const completeMessageProgress = useCallback((id: string) => {
    setProgressMessages(prev => prev.filter(msg => msg.id !== id));
  }, []);

  const appendWithFiles = useCallback(async (
    content: string, 
    attachments: FileAttachment[], 
    options?: { sessionId?: string }
  ) => {
    const messageWithAttachments = {
      role: 'user' as const,
      content,
      attachments
    };
    
    return chatHook.append(messageWithAttachments, { 
      options: { body: { sessionId: options?.sessionId } } 
    });
  }, [chatHook]);

  return {
    ...chatHook,
    messages: allMessages,
    addMessageWithProgress,
    updateMessageProgress,
    completeMessageProgress,
    appendWithFiles
  };
}