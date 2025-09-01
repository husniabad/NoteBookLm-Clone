'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Image, File, Upload, Loader2 } from 'lucide-react';

interface FileAttachment {
  name: string;
  type: string;
  size: number;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ExtendedMessage extends Message {
  attachments?: FileAttachment[];
  status?: 'sending' | 'uploading' | 'processing' | 'complete';
}

type MessagesProps = {
  messages: ExtendedMessage[];
};

const getFileIcon = (type: string) => {
  if (type.startsWith('image/')) return <Image className="h-3 w-3" aria-label="Image file" />;
  if (type === 'application/pdf') return <FileText className="h-3 w-3" aria-label="PDF file" />;
  return <File className="h-3 w-3" aria-label="File" />;
};

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
};

export default function Messages({ messages }: MessagesProps) {
  return (
    <div className="space-y-4">
      {messages.map((msg, index) => (
        <div
          key={index}
          className={`flex ${
            msg.role === 'user' ? 'justify-end' : 'justify-start'
          }`}
        >
          <div
            className={`p-3 rounded-lg max-w-lg ${
              msg.role === 'user'
                ? 'bg-violet-600 text-white'
                : 'bg-gray-200 text-gray-800'
            }`}
          >
            {msg.role === 'user' ? (
              <div>
                {msg.content}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {msg.attachments.map((file, index) => (
                      <div key={index} className="flex items-center gap-2 text-xs bg-violet-500 text-white px-2 py-1 rounded">
                        {getFileIcon(file.type)}
                        <span className="truncate max-w-24">{file.name}</span>
                        <span className="text-violet-200">({formatFileSize(file.size)})</span>
                      </div>
                    ))}
                  </div>
                )}
                {msg.status && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-violet-200">
                    {msg.status === 'sending' && (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Sending...</span>
                      </>
                    )}
                    {msg.status === 'uploading' && (
                      <>
                        <Upload className="h-4 w-4 animate-pulse" />
                        <span>Uploading files...</span>
                      </>
                    )}
                    {msg.status === 'processing' && (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Processing files...</span>
                      </>
                    )}
                    {msg.status === 'complete' && msg.attachments && msg.attachments.length > 0 && (
                      <span>Files processed and ready for analysis</span>
                    )}
                  </div>
                )}

              </div>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                className="prose prose-base max-w-none"
                components={{
                  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                  strong: ({ children }) => <strong className="font-bold text-gray-900">{children}</strong>,
                  em: ({ children }) => <em className="italic">{children}</em>,
                  code: ({ children }) => <code className="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono">{children}</code>,
                  pre: ({ children }) => <pre className="bg-gray-100 p-2 rounded overflow-x-auto">{children}</pre>,
                  ul: ({ children }) => <ul className="list-disc list-inside mb-2">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside mb-2">{children}</ol>,
                  li: ({ children }) => <li className="mb-1">{children}</li>,
                  h1: ({ children }) => <h1 className="text-lg font-bold mb-2">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-base font-bold mb-2">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-bold mb-1">{children}</h3>,
                  blockquote: ({ children }) => <blockquote className="border-l-4 border-gray-300 pl-3 italic">{children}</blockquote>,
                }}
              >
                {msg.content}
              </ReactMarkdown>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}