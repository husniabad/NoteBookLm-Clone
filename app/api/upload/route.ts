import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    const sessionId = formData.get('sessionId') as string;

    if (!files || files.length === 0 || !sessionId) {
      return NextResponse.json({ error: 'No files or session ID provided' }, { status: 400 });
    }

    // Process files immediately with blob upload
    const processPromises = files.map(async (file) => {
      const fileBuffer = Buffer.from(await file.arrayBuffer());
      
      // Upload to blob and get URL
      let blobUrl = null;
      try {
        const blob = await put(file.name, file, {
          access: 'public',
          addRandomSuffix: true,
        });
        blobUrl = blob.url;
      } catch (error) {
        console.error('Blob upload failed:', error);
      }
      
      // Process with file buffer and blob URL
      try {
        const processResponse = await fetch(new URL('/api/upload/process', req.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileBuffer: Array.from(fileBuffer),
            fileType: file.type,
            originalFileName: file.name,
            sessionId: sessionId,
            blobUrl: blobUrl,
          }),
        });
        
        if (!processResponse.ok) {
          console.error(`Error in processing. Status: ${processResponse.status}`);
        }
      } catch (processError) {
        console.error('Processing failed:', processError);
      }
    });

    // Wait for processing to complete to ensure blob URLs are stored
    await Promise.all(processPromises);

    return NextResponse.json({ success: true, message: 'File processing completed.' });

  } catch (error) {
    console.error('Error in upload processing:', error);
    return NextResponse.json({ error: 'Failed to process files' }, { status: 500 });
  }
}