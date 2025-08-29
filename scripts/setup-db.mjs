import { createPool } from "@vercel/postgres";
import dotenv from "dotenv";

dotenv.config({path: '.env.local'});

async function setupDatabase() {
    // Pass the connection string directly to the client
    const pool = createPool();

    try {
        // await client.connect(); // no need after switching to createPool
        console.log("Database pool created");

        await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
        console.log("pyvector extension created.")

        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS documents (
                id bigserial PRIMARY KEY,
                content TEXT NOT NULL,
                embedding vector(768)
            )
          `;
        await pool.query(createTableQuery);
        console.log("Table 'documents' created or already exists.");

    } catch (error) {
        console.error("Error connecting to the database:", error);
    } finally {
        await pool.end();
        console.log("Disconnected from the database.");
    
    }
}

setupDatabase();