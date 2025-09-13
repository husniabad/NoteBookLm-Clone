import { createPool } from "@vercel/postgres";
import dotenv from "dotenv";

dotenv.config({path: '.env.local'});

async function migrate() {
    const pool = createPool();
    try {
        await pool.query(`
            ALTER TABLE documents 
            ADD COLUMN IF NOT EXISTS session_id TEXT,
            ADD COLUMN IF NOT EXISTS source_file TEXT,
            ADD COLUMN IF NOT EXISTS is_standalone_file BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS url TEXT,
            ADD COLUMN IF NOT EXISTS page_number INTEGER,
            ADD COLUMN IF NOT EXISTS content_type VARCHAR(20) DEFAULT 'text',
            ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
        `);
        
        await pool.query(`
            UPDATE documents 
            SET content_type = 'text' WHERE content_type IS NULL,
                metadata = '{}'::jsonb WHERE metadata IS NULL
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_documents_session_id ON documents(session_id);
            CREATE INDEX IF NOT EXISTS idx_documents_content_type ON documents(content_type);
            CREATE INDEX IF NOT EXISTS idx_documents_metadata ON documents USING GIN(metadata);
        `);
        
        console.log("Migration complete");
    } finally {
        await pool.end();
    }
}

migrate();