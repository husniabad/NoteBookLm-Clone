-- Add content_type column to documents table
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_type VARCHAR(20) DEFAULT 'text';

-- Update existing records to have proper content_type
UPDATE documents SET content_type = 'text' WHERE content_type IS NULL;

-- Add index for better performance on content_type queries
CREATE INDEX IF NOT EXISTS idx_documents_content_type ON documents(content_type);
CREATE INDEX IF NOT EXISTS idx_documents_session_content_type ON documents(session_id, content_type);