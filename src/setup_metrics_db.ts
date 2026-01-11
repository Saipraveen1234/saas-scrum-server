import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL missing");
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function setupMetricsDB() {
  try {
    await client.connect();
    console.log("Connected to database...");

    // 1. Sprints Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS sprints (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        status VARCHAR(50) DEFAULT 'active', -- active, completed, planned
        goal TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Checked/Created 'sprints' table.");

    // 2. Sprint Snapshots (for Burnup)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sprint_snapshots (
        id SERIAL PRIMARY KEY,
        sprint_id INTEGER REFERENCES sprints(id),
        date DATE NOT NULL,
        total_points INTEGER DEFAULT 0,
        completed_points INTEGER DEFAULT 0,
        remaining_points INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(sprint_id, date)
      );
    `);
    console.log("Checked/Created 'sprint_snapshots' table.");

    // 3. Sprint Risks (AI Analysis)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sprint_risks (
        id SERIAL PRIMARY KEY,
        sprint_id INTEGER REFERENCES sprints(id),
        risk_score INTEGER, -- 0-100
        risk_level VARCHAR(50), -- Low, Moderate, High, Critical
        analysis TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Checked/Created 'sprint_risks' table.");

    // 4. Velocity History
    await client.query(`
      CREATE TABLE IF NOT EXISTS velocity_history (
        id SERIAL PRIMARY KEY,
        sprint_id INTEGER REFERENCES sprints(id),
        points_completed INTEGER DEFAULT 0,
        sprint_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Checked/Created 'velocity_history' table.");

    // 5. Task AI Insights (for Backlog)
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_ai_insights (
        id SERIAL PRIMARY KEY,
        task_id VARCHAR(255) NOT NULL, -- ClickUp Task ID
        suggestion_type VARCHAR(50), -- warning, split, improvement
        suggestion_text TEXT,
        status VARCHAR(50) DEFAULT 'pending', -- pending, accepted, rejected
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(task_id, suggestion_type)
      );
    `);
    console.log("Checked/Created 'task_ai_insights' table.");

    // 6. Retro Items
    await client.query(`
      CREATE TABLE IF NOT EXISTS retro_items (
        id SERIAL PRIMARY KEY,
        sprint_id INTEGER REFERENCES sprints(id),
        type VARCHAR(50), -- went_well, needs_improvement, action_item
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Checked/Created 'retro_items' table.");

    // Seed some initial data if empty
    const sprintsCheck = await client.query("SELECT COUNT(*) FROM sprints");
    if (parseInt(sprintsCheck.rows[0].count) === 0) {
        console.log("Seeding initial sprint data...");
        
        // Create a current sprint
        const today = new Date();
        const twoWeeksAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);
        const twoWeeksFromNow = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
        
        const sprintRes = await client.query(`
            INSERT INTO sprints (name, start_date, end_date, status, goal)
            VALUES ($1, $2, $3, 'active', 'Complete dashboard redesign and backend integration')
            RETURNING id
        `, ['Sprint 24', twoWeeksAgo, twoWeeksFromNow]);
        
        const sprintId = sprintRes.rows[0].id;

        // Seed snapshots for burnup
        for (let i = 0; i < 10; i++) {
            const d = new Date(twoWeeksAgo.getTime() + i * 24 * 60 * 60 * 1000);
            await client.query(`
                INSERT INTO sprint_snapshots (sprint_id, date, total_points, completed_points, remaining_points)
                VALUES ($1, $2, $3, $4, $5)
            `, [sprintId, d, 100, i * 8, 100 - (i * 8)]);
        }

        // Seed Risk
        await client.query(`
            INSERT INTO sprint_risks (sprint_id, risk_score, risk_level, analysis)
            VALUES ($1, 63, 'Moderate', 'Risk is moderate due to backend integration complexity.')
        `, [sprintId]);

        // Seed Velocity (Previous sprints)
        await client.query(`
            INSERT INTO velocity_history (sprint_name, points_completed) VALUES 
            ('Sprint 21', 45),
            ('Sprint 22', 52),
            ('Sprint 23', 48)
        `);
    }

    console.log("Database setup complete.");
  } catch (err) {
    console.error("Error setting up database:", err);
  } finally {
    await client.end();
  }
}

setupMetricsDB();
