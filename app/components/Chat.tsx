'use client';

import { useChat } from 'ai/react'; // Using the modern import path
import Messages from './Messages';
import { useEffect, useRef } from 'react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    api: '/api/chat', // Pointing to our backend chat API
  });

  // Auto-scroll to the bottom of the messages list
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="w-full max-w-2xl h-[70vh] flex flex-col bg-white border border-gray-200 rounded-lg shadow-md">
      {/* Messages Window */}
      <div ref={messagesContainerRef} className="flex-1 p-6 overflow-y-auto">
        <Messages messages={messages} />
      </div>

      {/* Input Form */}
      <div className="border-t border-gray-200 p-4 bg-gray-50">
        <form onSubmit={handleSubmit} className="flex items-center space-x-2">
          <input
            type="text"
            value={input}
            onChange={handleInputChange}
            placeholder="Ask a question about your document..."
            className="flex-1 p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
          <button
            type="submit"
            className="px-4 py-2 text-white bg-violet-600 rounded-lg hover:bg-violet-700 disabled:bg-gray-400"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}