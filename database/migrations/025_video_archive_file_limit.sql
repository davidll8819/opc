-- Edited videos share the existing 100 MiB workspace quota; ordinary uploads
-- retain their 6 MiB per-file limit.
ALTER TABLE workspace_files DROP CONSTRAINT workspace_files_data_check;
ALTER TABLE workspace_files ADD CONSTRAINT workspace_files_data_check
  CHECK (octet_length(data) <= CASE WHEN mime = 'video/mp4' THEN 104857600 ELSE 6291456 END);
