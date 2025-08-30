import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/app/lib/vercel-postgres';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
    }

    // Check if any documents exist for this session
    const { rows } = await sql`
      SELECT id FROM documents WHERE session_id = ${sessionId} LIMIT 1;
    `;

    if (rows.length > 0) {
      return NextResponse.json({ status: 'complete' });
    } else {
      return NextResponse.json({ status: 'pending' });
    }
  } catch (error) {
    console.error('Error checking status:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}