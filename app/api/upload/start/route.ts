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

    await Promise.all(files.map(async (file) => {
      const blob = await put(file.name, file, {
        access: 'public',
        addRandomSuffix: true,
      });

      // Trigger background processing
      try {
        const processResponse = await fetch(new URL('/api/upload/process', req.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            blobUrl: blob.url,
            originalFileName: file.name,
            sessionId: sessionId,
          }),
        });
        
        if (!processResponse.ok) {
          console.error(`Error triggering background job. Status: ${processResponse.status}`);
        }
      } catch (triggerError) {
        console.error('Background job trigger failed:', triggerError);
      }
    }));

    return NextResponse.json({ success: true, message: 'File processing initiated.' });

  } catch (error) {
    console.error('Error in upload start:', error);
    return NextResponse.json({ error: 'Failed to start upload process' }, { status: 500 });
  }
}