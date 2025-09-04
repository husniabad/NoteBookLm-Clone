import { createPool } from "@vercel/postgres";
import dotenv from "dotenv";

dotenv.config({path: '.env.local'});

async function addBlobUrlColumn() {
    const pool = createPool();

    try {
        console.log("Adding blob URL column to documents table...");
        
        // Check if url and page_number columns exist, if not add them
        await pool.query(`
            ALTER TABLE documents 
            ADD COLUMN IF NOT EXISTS url TEXT,
            ADD COLUMN IF NOT EXISTS page_number INTEGER
        `);
        
        console.log("Blob URL and page_number columns added successfully.");

    } catch (error) {
        console.error("Error adding blob URL column:", error);
    } finally {
        await pool.end();
        console.log("Disconnected from the database.");
    }
}

addBlobUrlColumn();