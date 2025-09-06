import { createPool } from "@vercel/postgres";
import dotenv from "dotenv";

dotenv.config({path: '.env.local'});

async function setupDatabase() {
    const pool = createPool();

    try {
        console.log("🚀 Setting up database...");

        await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        console.log("✓ Vector extension enabled");

        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS documents (
                id bigserial PRIMARY KEY,
                content TEXT,
                embedding vector(768),
                type TEXT DEFAULT 'text',
                session_id TEXT,
                source_file TEXT,
                is_standalone_file BOOLEAN DEFAULT FALSE,
                url TEXT,
                page_number INTEGER,
                content_type VARCHAR(20) DEFAULT 'text',
                metadata JSONB DEFAULT '{}'::jsonb,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `;
        await pool.query(createTableQuery);
        console.log("✓ Documents table created with all columns");

        // Create indexes for better performance
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_documents_session_id ON documents(session_id);
            CREATE INDEX IF NOT EXISTS idx_documents_content_type ON documents(content_type);
            CREATE INDEX IF NOT EXISTS idx_documents_session_content_type ON documents(session_id, content_type);
            CREATE INDEX IF NOT EXISTS idx_documents_metadata ON documents USING GIN(metadata);
            CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at);
            CREATE INDEX IF NOT EXISTS idx_documents_source_file ON documents(source_file);
        `);
        console.log("✓ Created performance indexes");
        
        console.log("🎉 Database setup completed successfully!");

    } catch (error) {
        console.error("❌ Database setup failed:", error);
        throw error;
    } finally {
        await pool.end();
        console.log("📝 Database connection closed");
    }
}

setupDatabase();