-- Personal, tenant-isolated knowledge and reusable workflows. Existing records are untouched.
CREATE TABLE reuse_entries (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('memory','knowledge','brand','template')),
 version integer NOT NULL DEFAULT 1, enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reuse_versions (
 entry_id uuid NOT NULL REFERENCES reuse_entries(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 version integer NOT NULL, title text NOT NULL, project text NOT NULL DEFAULT '',
 body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(entry_id,version)
);
CREATE INDEX reuse_owner ON reuse_entries(tenant_id,user_id,updated_at DESC);
CREATE TABLE reuse_runs (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 fingerprint text NOT NULL, batch_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,request_id)
);
CREATE TABLE task_notices_read (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 notice_key text NOT NULL, read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id,notice_key)
);
CREATE TABLE task_feedback (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 task_id text NOT NULL, rating text NOT NULL CHECK(rating IN ('adopted','revise','unusable')),
 note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE reuse_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE reuse_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY reuse_entries_owner ON reuse_entries USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE reuse_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reuse_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY reuse_versions_owner ON reuse_versions USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE reuse_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reuse_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY reuse_runs_owner ON reuse_runs USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE task_notices_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_notices_read FORCE ROW LEVEL SECURITY;
CREATE POLICY task_notices_read_owner ON task_notices_read USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE task_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY task_feedback_owner ON task_feedback USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
