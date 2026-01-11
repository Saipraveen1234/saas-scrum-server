import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Client } from "pg";
import jwt from 'jsonwebtoken';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// DB Client for role check (reusing the one from index.ts would be better, but for now creating a new pool or passing it is needed)
// To avoid circular deps or complex setup, let's just create a new client instance here or better, export the dbClient from index.ts?
// Exporting from index.ts might be circular if index imports this.
// Let's just create a pool here for simplicity or pass it in.
// Actually, for middleware, we usually attach the db client to the req or import a singleton db module.
// Let's create a simple db module `server/src/db.ts` to share the client.

// But first, let's just implement the token verification.

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name?: string;
    role: "admin" | "employee";
    team_id?: number | null;
    team_name?: string | null;
  };
}

export const authMiddleware =
  (dbClient: Client) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }

      const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as any;
      console.log(`[AuthMiddleware] User ID: ${decoded.id}`);

      // Continue to fetch full user roles from DB
      const roleResult = await dbClient.query(`
        SELECT ur.user_id, ur.email, ur.name, ur.role, ur.team_id, t.name as team_name 
        FROM user_roles ur 
        LEFT JOIN teams t ON ur.team_id = t.id 
        WHERE ur.user_id = $1
      `, [decoded.id]);

      let role: 'admin' | 'employee' = 'employee';
      let team_id: number | null = null;
      let team_name: string | null = null;
      let name: string = 'User';

      if (roleResult.rows.length > 0) {
        const row = roleResult.rows[0];
        role = row.role;
        team_id = row.team_id;
        team_name = row.team_name;
        name = row.name;
        
        (req as AuthRequest).user = {
          id: decoded.id,
          email: decoded.email,
          name: name,
          role: role,
          team_id: team_id,
          team_name: team_name
        };
        next();
      } else {
        // Should not happen if token is valid and user wasn't deleted
        return res.status(401).json({ error: 'User not found' });
      }

    } catch (err) {
      console.error('Token Verification Failed:', err);
      return res.status(401).json({ error: 'Invalid token' });
    }
    } catch (err) {
      console.error("Auth Middleware Error:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  };
