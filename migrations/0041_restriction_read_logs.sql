ALTER TABLE occ.iam_restrictions DROP CONSTRAINT iam_restrictions_action_valid;
--> statement-breakpoint
ALTER TABLE occ.iam_restrictions ADD CONSTRAINT iam_restrictions_action_valid CHECK (
  action IN (
    'create', 'read', 'update', 'delete', 'deploy', 'operate', 'administer', 'read_logs'
  )
);
