import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/vercel-postgres";

export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json();

    if (!sessionId) {
      return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
    }

    // Check if there are any documents for this session
    const result = await sql`
      SELECT COUNT(*) as count 
      FROM documents 
      WHERE session_id = ${sessionId}
    `;

    const count = parseInt(result.rows[0].count);
    
    return NextResponse.json({ 
      status: count > 0 ? 'complete' : 'processing',
      documentCount: count
    });

  } catch (error) {
    console.error('Error checking upload status:', error);
    return NextResponse.json({ error: 'Failed to check status' }, { status: 500 });
  }
}