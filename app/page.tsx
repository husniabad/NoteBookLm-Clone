'use client'; 

import { useState } from 'react';
import FileUpload from '@/app/components/FileUpload';
import Chat from '@/app/components/Chat'; // Import the new Chat component

export default function Home() {
  const [isDocumentUploaded, setIsDocumentUploaded] = useState(false);

  const handleUploadSuccess = () => {
    setIsDocumentUploaded(true);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-4">
      {!isDocumentUploaded ? (
        <FileUpload onUploadSuccess={handleUploadSuccess} />
      ) : (
        <Chat /> // Render the Chat component when the upload is successful
      )}
    </main>
  );
}
