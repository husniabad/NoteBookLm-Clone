import { createPool } from "@vercel/postgres";
import dotenv from "dotenv";

dotenv.config({path: '.env.local'});

async function addCreatedAtColumn() {
    const pool = createPool();

    try {
        console.log("Adding created_at column to documents table...");
        
        await pool.query(`
            ALTER TABLE documents 
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
        `);
        
        console.log("Created_at column added successfully.");

    } catch (error) {
        console.error("Error adding created_at column:", error);
    } finally {
        await pool.end();
        console.log("Disconnected from the database.");
    }
}

addCreatedAtColumn();