import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const router = express.Router();

// Helper to get DB client - in a real app, import from db module
// For now, accepting it as a param wouldn't work easily with Router export
// So we'll assume a new client or shared pool. 
// Given the existing structure, let's create a pool here or expect it passed.
// To keep it clean, let's export a function that takes the client.

export const authRoutes = (dbClient: Client) => {
  const router = express.Router();

  const registerHandler = async (req: Request, res: Response) => {
    try {
      const { email, password, name } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      // Check if user exists
      const existing = await dbClient.query('SELECT * FROM user_roles WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'User already exists' });
      }

      // Hash password
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);
      
      const userId = uuidv4();
      const userName = name || email.split('@')[0];

      // Insert User
      // Note: We are using the 'user_roles' table as our main user table now.
      const result = await dbClient.query(`
        INSERT INTO user_roles (user_id, email, password_hash, name, role)
        VALUES ($1, $2, $3, $4, 'employee')
        RETURNING user_id, email, name, role
      `, [userId, email, passwordHash, userName]);

      const user = result.rows[0];

      // Generate JWT
      const token = jwt.sign(
        { id: user.user_id, email: user.email, role: user.role },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '1d' }
      );

      res.status(201).json({ token, user });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  };

  router.post('/register', registerHandler);
  router.post('/signup', registerHandler);

  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const result = await dbClient.query('SELECT * FROM user_roles WHERE email = $1', [email]);
      
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];

      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign(
        { id: user.user_id, email: user.email, role: user.role },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '1d' }
      );

      // Return user info excluding password
      const userInfo = {
        user_id: user.user_id,
        email: user.email,
        name: user.name,
        role: user.role,
        team_id: user.team_id
      };

      res.json({ token, user: userInfo });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  return router;
};
