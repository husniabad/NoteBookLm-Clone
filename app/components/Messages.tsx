'use client';

import { Message } from 'ai';

type MessagesProps = {
  messages: Message[];
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
            {msg.content}
          </div>
        </div>
      ))}
    </div>
  );
}