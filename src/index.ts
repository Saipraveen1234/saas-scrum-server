import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Client } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ClickUpService } from "./clickup.service";
import { BotService } from "./bot.service";
import { authMiddleware, AuthRequest } from "./middleware/auth.middleware";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: true, // Reflect request origin
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true
}));
app.options('*', cors()); // Enable pre-flight for all routes
app.use((req, res, next) => {
  console.log(`[Request] ${req.method} ${req.url}`);
  next();
});
app.use(express.json());

// Database Setup
if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL missing");
  process.exit(1);
}
const isLocal = process.env.DATABASE_URL?.includes('@postgres:5432');
const dbClient = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
dbClient.connect().catch((err) => console.error("DB Error:", err));

// AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const clickupService = new ClickUpService();
const botService = new BotService();

// --- ROUTES ---
import { authRoutes } from "./routes/auth";
app.use("/api/auth", authRoutes(dbClient));

// --- BOT ROUTES ---
app.post("/api/bot/join", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const { meetingUrl, botName } = req.body;
    if (!meetingUrl) return res.status(400).json({ error: "Method URL required" });

    // Default name if not provided
    const name = botName || "Scrum Bot";

    // Non-blocking call ideally, but for MVP we wait for join request
    const result = await botService.joinMeeting(meetingUrl, name);
    res.json(result);
  } catch (error: any) {
    console.error("Bot Join Error:", error);
    res.status(500).json({ error: error.message || "Failed to join meeting" });
  }
});

app.post("/api/bot/leave", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const result = await botService.leaveMeeting();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to leave meeting" });
  }
});

app.get("/api/bot/status", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const status = botService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: "Failed to get bot status" });
  }
});

app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "OK" });
});

// 1. GET STANDUPS
app.get("/api/standups", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    let query = "SELECT * FROM standups ORDER BY created_at DESC LIMIT 50";
    let params: any[] = [];

    if (user.role === 'employee') {
      query = "SELECT * FROM standups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50";
      params = [user.id];
    }

    const result = await dbClient.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

// 11. UPDATE TASK STATUS
app.put("/api/tasks/:id/status", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const taskId = req.params.id;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: "Status is required" });
    }

    const result = await clickupService.updateTaskStatus(taskId, status);
    res.json(result);
  } catch (error) {
    console.error("Update task status failed:", error);
    res.status(500).json({ error: "Failed to update task status" });
  }
});

// 12. AI HELPERS
app.post("/api/ai/generate-description", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const { taskName, taskType } = req.body;
    const prompt = `
      You are an expert product manager. Write a detailed, professional description for a task named "${taskName}".
      Task Type: ${taskType || 'General Development'}
      
      Include:
      - Objective
      - Key Requirements (bullet points)
      - Acceptance Criteria (bullet points)
      
      Keep it concise but comprehensive. Use Markdown format.
    `;

    const result = await model.generateContent(prompt);
    res.json({ description: result.response.text() });
  } catch (error) {
    console.error("AI Description failed:", error);
    res.status(500).json({ error: "Failed to generate description" });
  }
});

app.post("/api/ai/estimate-time", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const { taskName, description } = req.body;
    const prompt = `
      You are a senior software engineer. Estimate the time required to complete the following task:
      Task: "${taskName}"
      Description: "${description}"
      
      Provide a realistic time estimate in hours (e.g., "4 hours", "2 days").
      Briefly explain the reasoning (1-2 sentences).
      
      Return ONLY a JSON object: { "estimate": "string", "reasoning": "string" }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    res.json(JSON.parse(text));
  } catch (error) {
    console.error("AI Estimation failed:", error);
    res.status(500).json({ error: "Failed to estimate time" });
  }
});

// 2. POST STANDUP
app.post("/api/standups", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    // Ensure employees can only post for themselves (though the UI might send user_name, we should trust the token more or validate)
    // For now, we'll trust the token for user_id, and maybe keep user_name from body or fetch it?
    // The current DB has user_name. We should probably fetch it from user_roles or just use what's sent but ensure user_id is set.

    const { user_name, yesterday, today, blockers } = req.body;

    const result = await dbClient.query(
      `
      INSERT INTO standups (user_name, yesterday, today, blockers, user_id)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `,
      [user_name, yesterday, today, blockers, user.id]
    );
    const savedStandup = result.rows[0];

    // --- AUTO-UPDATE TICKETS ---
    let updatedTasks: any[] = [];
    try {
      const listId = process.env.CLICKUP_LIST_ID;
      if (listId) {
        const allTasks = await clickupService.getTasks(listId);
        // Filter tasks assigned to user
        const myTasks = allTasks.filter((task: any) =>
          task.assignees?.some((a: any) => a.email === user.email)
        );

        if (myTasks.length > 0) {
          const taskSummary = myTasks.map((t: any) =>
            `- ID: ${t.id}, Name: "${t.name}", Status: ${t.status.status}`
          ).join('\n');

          const prompt = `
            You are an AI assistant that manages task statuses.
            
            User's Standup Update:
            Yesterday: "${yesterday}"
            Today: "${today}"
            
            User's Assigned Tasks:
            ${taskSummary}
            
            Based on the update, identify if any tasks should be marked as "Closed" or "Complete".
            Only mark a task as complete if the user explicitly says they finished, completed, or done with it.
            
            Return a JSON array of objects with "taskId" and "newStatus" (use "closed" for completion).
            If no tasks are completed, return an empty array [].
            Example: [{"taskId": "123", "newStatus": "closed"}]
          `;

          const aiResult = await model.generateContent(prompt);
          const text = aiResult.response.text();
          const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
          const updates = JSON.parse(jsonStr);

          if (Array.isArray(updates) && updates.length > 0) {
            for (const update of updates) {
              if (update.taskId && update.newStatus) {
                await clickupService.updateTaskStatus(update.taskId, update.newStatus);
                updatedTasks.push(update);
                console.log(`[AutoUpdate] Task ${update.taskId} marked as ${update.newStatus}`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("Auto-update tickets failed:", err);
      // Don't fail the request if this part fails
    }

    res.status(201).json({ ...savedStandup, updatedTasks });
  } catch (error) {
    res.status(500).json({ error: "Save failed" });
  }
});

// --- TEAMS ROUTES ---

// 6. GET TEAMS
app.get("/api/teams", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const result = await dbClient.query("SELECT * FROM teams ORDER BY name");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Fetch teams failed" });
  }
});

// 7. CREATE TEAM
app.post("/api/teams", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (user?.role !== 'admin') return res.status(403).json({ error: "Forbidden" });

    const { name } = req.body;
    const result = await dbClient.query(
      "INSERT INTO teams (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Create team failed" });
  }
});

// 8. GET USERS (for admin to assign teams)
app.get("/api/users", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (user?.role !== 'admin') return res.status(403).json({ error: "Forbidden" });

    const result = await dbClient.query(`
      SELECT ur.user_id, ur.email, ur.name, ur.role, ur.team_id, t.name as team_name
      FROM user_roles ur
      LEFT JOIN teams t ON ur.team_id = t.id
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Fetch users failed" });
  }
});

// 8.4 GET USER COUNT
app.get("/api/users/count", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const result = await dbClient.query("SELECT COUNT(*) FROM user_roles WHERE role = 'employee'");
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (error) {
    res.status(500).json({ error: "Fetch user count failed" });
  }
});

// 8.5 GET CURRENT USER
app.get("/api/users/me", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Fetch me failed" });
  }
});

// 8.6 UPDATE CURRENT USER
app.put("/api/users/me", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const { name } = req.body;

    // Update user_roles table
    // We assume user_roles has a 'name' column. If not, we need to add it or update where appropriate.
    // Based on previous context, user_roles has 'name'.

    const result = await dbClient.query(
      "UPDATE user_roles SET name = $1 WHERE user_id = $2 RETURNING *",
      [name, user.id]
    );

    if (result.rowCount === 0) {
      // If user not in user_roles yet (weird but possible if authMiddleware creates mock), insert?
      // For now assume they exist.
      return res.status(404).json({ error: "User not found" });
    }

    // Return updated user info merged with existing role/team info
    // Actually we can just return what we updated or fetch fresh.
    // Let's return the updated row.
    const updated = result.rows[0];

    // We need to return the full user object structure expected by frontend
    // Re-fetch full details to be safe
    const fullUserRes = await dbClient.query(`
      SELECT ur.user_id, ur.email, ur.name, ur.role, ur.team_id, t.name as team_name
      FROM user_roles ur
      LEFT JOIN teams t ON ur.team_id = t.id
      WHERE ur.user_id = $1
    `, [user.id]);

    res.json(fullUserRes.rows[0]);
  } catch (error) {
    console.error("Update user failed:", error);
    res.status(500).json({ error: "Update failed" });
  }
});

// 9. ASSIGN USER TO TEAM
app.put("/api/users/:id/team", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (user?.role !== 'admin') return res.status(403).json({ error: "Forbidden" });

    const { team_id } = req.body;
    const targetUserId = req.params.id;

    await dbClient.query(
      "UPDATE user_roles SET team_id = $1 WHERE user_id = $2",
      [team_id, targetUserId]
    );
    res.json({ status: "Updated" });
  } catch (error) {
    res.status(500).json({ error: "Update user team failed" });
  }
});

// 3. GENERATE AI SUMMARY (Updated for Teams)
app.post("/api/summary", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const { date } = req.body;

    // Default to today if no date provided
    let targetDate = new Date().toISOString().split('T')[0];
    if (date) {
      targetDate = date;
    }

    // A. Get data for the specific date with team info
    const result = await dbClient.query(`
      SELECT s.*, t.name as team_name 
      FROM standups s
      LEFT JOIN user_roles ur ON s.user_id = ur.user_id
      LEFT JOIN teams t ON ur.team_id = t.id
      WHERE s.created_at::date = $1
      ORDER BY t.name, s.created_at DESC 
      LIMIT 50
    `, [targetDate]);
    const updates = result.rows;

    if (updates.length === 0)
      return res.json({ summary: "No updates available to summarize." });

    // B. Group by Team
    const updatesByTeam: Record<string, any[]> = {};
    updates.forEach((u: any) => {
      const team = u.team_name || 'Unassigned';
      if (!updatesByTeam[team]) updatesByTeam[team] = [];
      updatesByTeam[team].push(u);
    });

    // C. Construct Prompt
    let updatesText = "";
    for (const [team, teamUpdates] of Object.entries(updatesByTeam)) {
      updatesText += `\nTeam: ${team}\n`;
      updatesText += teamUpdates.map(
        (u: any) => `- ${u.user_name}: Done: "${u.yesterday}", Doing: "${u.today}", Blockers: "${u.blockers}"`
      ).join("\n");
    }

    const prompt = `
      You are an expert Scrum Master. Summarize these daily updates for the Team Lead, grouped by Project Team.
      
      For each Team:
      1. **Team Name**
      2. **Critical Blockers**
      3. **Key Progress**
      4. **Risk Level** (Low/High)

      Updates:
      ${updatesText}
    `;

    // D. Call Gemini
    const aiResult = await model.generateContent(prompt);
    const summary = aiResult.response.text();

    res.json({ summary });
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: "AI generation failed" });
  }

});

// 3.1 POST TO SLACK
app.post("/api/standups/slack", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const { summary } = req.body;
    // In a real app, we would use a Slack Webhook URL from env
    // const slackUrl = process.env.SLACK_WEBHOOK_URL;
    // await fetch(slackUrl, { method: 'POST', body: JSON.stringify({ text: summary }) });

    console.log("Posting to Slack:", summary);
    res.json({ status: "Posted" });
  } catch (error) {
    res.status(500).json({ error: "Slack post failed" });
  }
});

// 10. GET TASKS (ClickUp)
app.get("/api/tasks", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const listId = process.env.CLICKUP_LIST_ID;

    if (!listId) {
      return res.json([]);
    }

    const allTasks = await clickupService.getTasks(listId);

    // Check if admin wants all tasks
    const showAll = req.query.all === 'true';

    if (showAll && user.role === 'admin') {
      return res.json(allTasks);
    }

    // Filter tasks assigned to the current user
    const myTasks = allTasks.filter((task: any) => {
      const assignees = task.assignees || [];
      return assignees.some((assignee: any) => assignee.email === user.email);
    });

    res.json(myTasks);
  } catch (error) {
    console.error("Fetch tasks failed:", error);
    res.status(500).json({ error: "Fetch tasks failed" });
  }
});

// --- ROUTES REMOVED (Backlog, Planning, Reports) ---

// 16. CHAT WITH AI SCRUM ASSISTANT
app.post("/api/chat", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const user = (req as AuthRequest).user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });

    // 1. Gather Context
    let context = `User: ${user.name} (${user.role})`;
    if (user.team_name) context += `, Team: ${user.team_name}`;

    const sprintRes = await dbClient.query("SELECT * FROM sprints WHERE status = 'active' LIMIT 1");
    if (sprintRes.rowCount && sprintRes.rowCount > 0) {
      const sprint = sprintRes.rows[0];
      context += `\nCurrent Sprint: ${sprint.name}, Goal: ${sprint.goal}`;
    }

    // Fetch Tasks (if relevant)
    // Simple heuristic: if message contains keywords, fetch tasks
    const lowerMsg = message.toLowerCase();
    if (lowerMsg.includes('task') || lowerMsg.includes('todo') || lowerMsg.includes('pending') || lowerMsg.includes('work') || lowerMsg.includes('ticket') || lowerMsg.includes('issue')) {
      const listId = process.env.CLICKUP_LIST_ID;
      if (listId) {
        const allTasks = await clickupService.getTasks(listId);
        let relevantTasks = allTasks;

        // If employee, filter to their tasks unless they ask for "team" or "all"
        if (user.role === 'employee' && !lowerMsg.includes('team') && !lowerMsg.includes('all')) {
          relevantTasks = allTasks.filter((task: any) =>
            task.assignees?.some((a: any) => a.email === user.email)
          );
        }

        const taskSummary = relevantTasks.map((t: any) =>
          `- ${t.name} (Status: ${t.status.status}) [Assignees: ${t.assignees.map((a: any) => a.username).join(', ')}]`
        ).join('\n');

        context += `\n\nRelevant Tasks:\n${taskSummary}`;
      }
    }

    // Fetch Standups (if relevant)
    if (lowerMsg.includes('standup') || lowerMsg.includes('update') || lowerMsg.includes('blocker')) {
      const standupsRes = await dbClient.query("SELECT * FROM standups ORDER BY created_at DESC LIMIT 20");
      const standupSummary = standupsRes.rows.map((s: any) =>
        `- ${s.user_name}: ${s.today} (Blockers: ${s.blockers})`
      ).join('\n');
      context += `\n\nRecent Standups:\n${standupSummary}`;
    }

    // 2. Construct Prompt
    const prompt = `
      You are an AI Scrum Assistant for Velos AI.
      Your goal is to help the user (${user.name}, ${user.role}) with their daily work and sprint progress.
      
      Context Data:
      ${context}

      User Question: "${message}"

      Answer the user's question concisely and helpfully based on the context provided.
      If you don't have the info, say so.
      Format your response in Markdown.
    `;

    // 3. Call Gemini
    const result = await model.generateContent(prompt);
    const response = result.response.text();

    res.json({ response });
  } catch (error) {
    console.error("Chat failed:", error);
    res.status(500).json({ error: "Chat failed" });
  }
});

// DEBUG ROUTE
app.get("/api/debug-user", async (req: Request, res: Response) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email required" });

    const result = await dbClient.query("SELECT * FROM user_roles WHERE email = $1", [email]);
    res.json({
      count: result.rowCount,
      rows: result.rows,
      db_url_masked: process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 20) + '...' : 'Not Set'
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// --- SPRINT PLANNING ROUTES ---

// 11. ANALYZE BACKLOG
app.post("/api/planning/analyze", authMiddleware(dbClient), async (req: Request, res: Response) => {
  try {
    const listId = process.env.CLICKUP_LIST_ID;
    if (!listId) return res.status(500).json({ error: "CLICKUP_LIST_ID not set" });

    // Fetch all tasks
    const tasks = await clickupService.getTasks(listId);

    // Filter for non-done tasks (assuming 'status' field exists and 'closed' is done)
    // Adjust logic based on actual ClickUp statuses. For now, take everything not 'complete'
    const backlog = tasks.filter((t: any) => t.status.status !== 'complete' && t.status.status !== 'done');

    if (backlog.length === 0) return res.json({ tasks: [] });

    // AI Analysis
    const prompt = `
      Analyze these backlog items for a Sprint Planning session.
      For each item, provide:
      1. "ready": boolean (is it clear enough to start?)
      2. "estimate": number (estimated story points, 1-8 Fibonacci. Guess based on complexity if missing)
      3. "notes": string (brief observation, e.g., "Unclear scope", "Dependency on X")

      Items:
      ${backlog.map((t: any) => `- ID: ${t.id}, Name: "${t.name}", Desc: "${(t.description || '').substring(0, 100)}..."`).join('\n')}

      Return ONLY a JSON array of objects with keys: id, ready, estimate, notes.
    `;

    const aiResult = await model.generateContent(prompt);
    const text = aiResult.response.text();

    // Parse JSON from AI response (handle potential markdown blocks)
    const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const analysis = JSON.parse(jsonStr);

    // Merge analysis with original task data
    const analyzedTasks = backlog.map((t: any) => {
      const a = analysis.find((x: any) => x.id === t.id) || {};
      return { ...t, ...a };
    });

    res.json({ tasks: analyzedTasks });
  } catch (error) {
    console.error("Analyze failed:", error);
    res.status(500).json({ error: "Analysis failed" });
  }
});


