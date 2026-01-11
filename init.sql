-- Create tables based on application usage

CREATE TABLE IF NOT EXISTS teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id VARCHAR(255) PRIMARY KEY, -- Using UUID in code
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'employee', -- 'admin', 'employee'
    team_id INTEGER REFERENCES teams(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS standups (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) REFERENCES user_roles(user_id),
    user_name VARCHAR(255),
    yesterday TEXT,
    today TEXT,
    blockers TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sprints (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'planned', -- 'active', 'completed', 'planned'
    goal TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sprint_snapshots (
    id SERIAL PRIMARY KEY,
    sprint_id INTEGER REFERENCES sprints(id),
    date DATE NOT NULL,
    total_points INTEGER DEFAULT 0,
    completed_points INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sprint_risks (
    id SERIAL PRIMARY KEY,
    sprint_id INTEGER REFERENCES sprints(id),
    risk_score INTEGER,
    risk_level VARCHAR(50),
    analysis TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS velocity_history (
    id SERIAL PRIMARY KEY,
    sprint_name VARCHAR(255),
    total_points INTEGER,
    completed_points INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_ai_insights (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(255) NOT NULL,
    suggestion_type VARCHAR(50),
    suggestion_text JSONB,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id, suggestion_type)
);


-- SEED DATA FOR DEMO

-- 1. Create a Default Team
INSERT INTO teams (name) VALUES ('Engineering Team Alpha');

-- 2. Create Users
-- Password for all is: password123
INSERT INTO user_roles (user_id, email, password_hash, name, role, team_id) VALUES
('demo-user-id-001', 'demo@example.com', '$2b$10$G9t2BhMKO5ZUwuq5wvUip.9A13xAioMP4dlx8KFmyDntHRLa/LVjG', 'Demo Admin', 'admin', 1),
('demo-user-id-002', 'alice@example.com', '$2b$10$G9t2BhMKO5ZUwuq5wvUip.9A13xAioMP4dlx8KFmyDntHRLa/LVjG', 'Alice Engineer', 'employee', 1),
('demo-user-id-003', 'bob@example.com', '$2b$10$G9t2BhMKO5ZUwuq5wvUip.9A13xAioMP4dlx8KFmyDntHRLa/LVjG', 'Bob Frontend', 'employee', 1);

-- 7. Standups (For active users)
INSERT INTO standups (user_id, user_name, yesterday, today, blockers) VALUES
('demo-user-id-001', 'Demo Admin', 'Reviewed PRs and planned sprint scope.', 'Setting up CI/CD pipelines.', 'None'),
('demo-user-id-002', 'Alice Engineer', 'Completed API endpoints for user auth.', 'Writing unit tests for auth middleware.', 'Waiting for API specs.'),
('demo-user-id-003', 'Bob Frontend', 'Fixed CSS issues on login page.', 'Integrating new Auth API.', 'CORS issues (resolved).');

-- 3. Sprints
INSERT INTO sprints (name, start_date, end_date, status, goal) VALUES
('Sprint 23', CURRENT_DATE - INTERVAL '14 days', CURRENT_DATE - INTERVAL '1 day', 'completed', 'Backend migration and Docker setup'),
('Sprint 24', CURRENT_DATE, CURRENT_DATE + INTERVAL '14 days', 'active', 'Frontend Integration and Dashboard Polish'),
('Sprint 25', CURRENT_DATE + INTERVAL '14 days', CURRENT_DATE + INTERVAL '28 days', 'planned', 'AI Features Expansion');

-- 4. Velocity History (Past Sprints)
INSERT INTO velocity_history (sprint_name, total_points, completed_points) VALUES
('Sprint 20', 45, 40),
('Sprint 21', 50, 48),
('Sprint 22', 48, 45),
('Sprint 23', 52, 50);

-- 5. Sprint Risks (Active Sprint)
INSERT INTO sprint_risks (sprint_id, risk_score, risk_level, analysis) VALUES
(2, 25, 'Low', 'Velocity is stable. No major blockers identified.'),
(2, 65, 'High', 'Frontend integration facing delays due to API mismatch.');

-- 6. Sprint Snapshots (Burndown for active sprint)
INSERT INTO sprint_snapshots (sprint_id, date, total_points, completed_points) VALUES
(2, CURRENT_DATE - INTERVAL '2 days', 50, 0),
(2, CURRENT_DATE - INTERVAL '1 day', 50, 5),
(2, CURRENT_DATE, 50, 12);
