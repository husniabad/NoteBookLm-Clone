// in /scripts/setup-db.ts
import { sql } from '@vercel/postgres';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function setupDatabase() {
  console.log('🚀 Setting up database...');

  const client = await sql.connect();
  try {
    await client.sql`BEGIN`;

    // 0. Drop existing tables if they exist
    await client.sql`DROP TABLE IF EXISTS chat_messages CASCADE;`;
    await client.sql`DROP TABLE IF EXISTS chunks CASCADE;`;
    await client.sql`DROP TABLE IF EXISTS documents CASCADE;`;
    console.log("✓ Existing tables dropped.");

    // 1. Enable vector extension
    await client.sql`CREATE EXTENSION IF NOT EXISTS vector;`;
    console.log("✓ Vector extension enabled.");

    // 2. Create the 'documents' table for blueprints
    await client.sql`
      CREATE TABLE IF NOT EXISTS documents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id VARCHAR(255), 
          source_file VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          blueprint JSONB NOT NULL,
          pdf_url TEXT
      );
    `;
    console.log("✓ 'documents' table created.");

    // 3. Create the 'chunks' table for embeddings
    await client.sql`
      CREATE TABLE IF NOT EXISTS chunks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          embedding VECTOR(1024), -- Or your model's dimension
          page_number INTEGER
      );
    `;
    console.log("✓ 'chunks' table created.");

    // 4. Create the 'chat_messages' table for conversation history
    await client.sql`
      CREATE TABLE IF NOT EXISTS chat_messages (
          id SERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
      );
    `;
    console.log("✓ 'chat_messages' table created.");
    
    await client.sql`COMMIT`;
    console.log("🎉 Database setup completed successfully!");

  } catch (error) {
    await client.sql`ROLLBACK`;
    console.error('❌ Database setup failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

setupDatabase();