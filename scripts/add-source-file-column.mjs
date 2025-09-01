import { createPool } from "@vercel/postgres";
import dotenv from "dotenv";

dotenv.config({path: '.env.local'});

async function addSourceFileColumn() {
    const pool = createPool();

    try {
        console.log("Adding source_file column to documents table...");
        
        await pool.query(`
            ALTER TABLE documents 
            ADD COLUMN IF NOT EXISTS source_file TEXT,
            ADD COLUMN IF NOT EXISTS is_standalone_file BOOLEAN DEFAULT FALSE
        `);
        
        console.log("Source file columns added successfully.");

    } catch (error) {
        console.error("Error adding source_file column:", error);
    } finally {
        await pool.end();
        console.log("Disconnected from the database.");
    }
}

addSourceFileColumn();