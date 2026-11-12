-- Additive only: existing assignments, histories and model settings are untouched.
CREATE TABLE employee_duty (
 tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id text NOT NULL,
 seat integer CHECK(seat BETWEEN 0 AND 8), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,employee_id), UNIQUE(tenant_id,seat)
);
CREATE TABLE employee_work_leases (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE skill_studio (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), created_by uuid NOT NULL REFERENCES users(id),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE skill_studio_versions (
 entry_id uuid NOT NULL REFERENCES skill_studio(id), tenant_id uuid NOT NULL REFERENCES tenants(id),
 version integer NOT NULL, title text NOT NULL, requirement text NOT NULL, instructions text NOT NULL,
 installed_id uuid REFERENCES installed_skills(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(entry_id,version)
);
CREATE TABLE skill_studio_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 entry_id uuid NOT NULL REFERENCES skill_studio(id), version integer NOT NULL, employee_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('generate','trial')), input text NOT NULL,
 state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','completed','failed')),
 output text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_work_leases_active ON employee_work_leases(tenant_id,employee_id,expires_at);
CREATE INDEX skill_studio_tenant ON skill_studio(tenant_id,updated_at DESC);
ALTER TABLE employee_duty ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_duty FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_duty_scope ON employee_duty USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE employee_work_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_work_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_work_leases_scope ON employee_work_leases USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE skill_studio ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_studio FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_studio_scope ON skill_studio USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE skill_studio_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_studio_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_studio_versions_scope ON skill_studio_versions USING(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE skill_studio_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_studio_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_studio_runs_scope ON skill_studio_runs USING(tenant_id::text=current_setting('app.tenant_id',true));
