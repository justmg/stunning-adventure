const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../deepgram-twilio-streaming-voice-agent/.env') });

async function setupDatabase() {
  // Check if DATABASE_URL is properly configured
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('username:password')) {
    console.error('DATABASE_URL is not properly configured in .env file');
    console.log('Please update your .env file with the actual Railway PostgreSQL connection string:');
    console.log('DATABASE_URL=postgresql://username:password@postgres-production-1a6d.up.railway.app:port/database_name');
    console.log('\nYou can find these details in your Railway PostgreSQL service dashboard.');
    return;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL database');

    // Read the schema file
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Execute the schema
    await client.query(schema);
    console.log('Schema created successfully');

    // Verify tables were created
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    `);
    
    console.log('Created tables:');
    result.rows.forEach(row => {
      console.log(`- ${row.table_name}`);
    });

  } catch (error) {
    console.error('Error setting up database:', error);
  } finally {
    await client.end();
  }
}

setupDatabase();