import { createPool } from "@vercel/postgres";
import dotenv from "dotenv";

dotenv.config({path: '.env.local'});

async function createChatMessagesTable() {
    const pool = createPool();

    try {
        console.log("Creating chat_messages table...");
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        console.log("Chat messages table created successfully.");

    } catch (error) {
        console.error("Error creating chat_messages table:", error);
    } finally {
        await pool.end();
        console.log("Disconnected from the database.");
    }
}

createChatMessagesTable();