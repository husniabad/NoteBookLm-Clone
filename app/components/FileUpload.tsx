'use client'; // This is a client component

import { useState } from 'react';

// Define the type for our component's props
type FileUploadProps = {
  onUploadSuccess: () => void;
};

export default function FileUpload({ onUploadSuccess }: FileUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFile(e.target.files[0]);
      setStatus('idle');
      setMessage('');
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) {
      setMessage('Please select a file to upload.');
      return;
    }

    setStatus('uploading');
    setMessage('Uploading and processing...');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (response.ok) {
        setStatus('success');
        setMessage(data.message || 'File processed successfully!');
        onUploadSuccess(); // Notify the parent component
      } else {
        setStatus('error');
        setMessage(data.error || 'An error occurred.');
      }
    } catch (error) {
      setStatus('error');
      setMessage('An unexpected error occurred.');
      console.error('Upload error:', error);
    }
  };

  return (
    <div className="w-full max-w-md p-6 bg-white border border-gray-200 rounded-lg shadow-md">
      <h2 className="text-2xl font-bold mb-4 text-center text-gray-800">Upload Your Document</h2>
      <p className="text-sm text-gray-500 mb-4 text-center">
        Upload a PDF, TXT, or Image file to begin.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <input
            type="file"
            onChange={handleFileChange}
            accept=".pdf,.txt,.md,.png,.jpg,.jpeg"
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100"
          />
        </div>
        <button
          type="submit"
          disabled={!file || status === 'uploading'}
          className="w-full px-4 py-2 text-white bg-violet-600 rounded-md hover:bg-violet-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {status === 'uploading' ? 'Processing...' : 'Upload & Process'}
        </button>
      </form>
      {message && (
        <p
          className={`mt-4 text-sm text-center font-medium ${
            status === 'error' ? 'text-red-500' : 'text-green-500'
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}