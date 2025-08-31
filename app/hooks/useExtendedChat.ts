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
  insertionIndex: number;
}

export function useExtendedChat(options: { api: string; body?: Record<string, unknown> }) {
  const chatHook = useChat(options);
  const [progressMessages, setProgressMessages] = useState<ProgressMessage[]>([]);
  const [messageOrder, setMessageOrder] = useState<string[]>([]);

  // Combine messages maintaining insertion order
  const allMessages: ExtendedMessage[] = [];
  
  // Add messages in the order they were created
  messageOrder.forEach(id => {
    const regularMsg = chatHook.messages.find(m => m.id === id);
    const progressMsg = progressMessages.find(m => m.id === id);
    if (regularMsg) allMessages.push(regularMsg);
    if (progressMsg) allMessages.push(progressMsg);
  });
  
  // Add any new regular messages not in order yet
  chatHook.messages.forEach(msg => {
    if (!messageOrder.includes(msg.id)) {
      allMessages.push(msg);
      setMessageOrder(prev => [...prev, msg.id]);
    }
  });

  const addMessageWithProgress = useCallback((content: string, attachments: FileAttachment[], status: string) => {
    const messageId = crypto.randomUUID();
    
    const progressMessage: ProgressMessage = {
      id: messageId,
      role: 'user',
      content,
      attachments,
      status: status as 'uploading' | 'processing' | 'complete',
      createdAt: new Date(),
      insertionIndex: 0
    };
    
    setProgressMessages(prev => [...prev, progressMessage]);
    setMessageOrder(prev => [...prev, messageId]);
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

  const clearAllMessages = useCallback(() => {
    chatHook.setMessages([]);
    setProgressMessages([]);
  }, [chatHook]);

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
    appendWithFiles,
    clearAllMessages
  };
}