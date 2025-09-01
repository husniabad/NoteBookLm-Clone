import { createPool } from "@vercel/postgres";
import dotenv from "dotenv";

dotenv.config({path: '.env.local'});

async function addSessionColumn() {
    const pool = createPool();

    try {
        console.log("Adding session_id column to documents table...");
        
        await pool.query(`
            ALTER TABLE documents 
            ADD COLUMN IF NOT EXISTS session_id TEXT
        `);
        
        console.log("Session column added successfully.");

    } catch (error) {
        console.error("Error adding session column:", error);
    } finally {
        await pool.end();
        console.log("Disconnected from the database.");
    }
}

addSessionColumn();