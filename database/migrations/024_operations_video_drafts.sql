CREATE TABLE operations_video_drafts (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 task_id text NOT NULL CHECK(task_id ~ '^[a-f0-9]{24}$'),
 content jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id,task_id)
);
ALTER TABLE operations_video_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_video_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_video_drafts_private ON operations_video_drafts
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
