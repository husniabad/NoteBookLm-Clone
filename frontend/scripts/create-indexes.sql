-- Database optimization indexes
-- Run this in your Vercel Postgres database

-- Index for session-based filtering (most important for performance)
CREATE INDEX IF NOT EXISTS idx_documents_session_id ON documents(session_id);

-- Index for vector similarity search (requires pgvector extension)
-- Note: This requires the pgvector extension to be enabled
-- CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Composite index for session + vector search
CREATE INDEX IF NOT EXISTS idx_documents_session_embedding ON documents(session_id) INCLUDE (embedding, content, type);

-- Optional: Index for document type filtering
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);