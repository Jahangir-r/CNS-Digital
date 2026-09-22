// These guards protect content even when writes bypass the HTTP/service layer.
export const TEMPLATE_SCHEMA = `
CREATE TABLE checklist_templates (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE CHECK(length(trim(code)) > 0),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  current_version_id TEXT REFERENCES checklist_template_versions(id) ON DELETE RESTRICT,
  archived_at TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE checklist_template_versions (
  id TEXT PRIMARY KEY NOT NULL,
  template_id TEXT NOT NULL REFERENCES checklist_templates(id) ON DELETE RESTRICT,
  major INTEGER NOT NULL CHECK(typeof(major)='integer' AND major >= 1),
  minor INTEGER NOT NULL CHECK(typeof(minor)='integer' AND minor >= 0),
  version_label TEXT NOT NULL CHECK(version_label = CAST(major AS TEXT) || '.' || CAST(minor AS TEXT)),
  status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
  based_on_version_id TEXT REFERENCES checklist_template_versions(id) ON DELETE RESTRICT,
  name_snapshot TEXT NOT NULL CHECK(length(trim(name_snapshot)) > 0),
  content_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision >= 1),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  published_by INTEGER,
  published_at TEXT,
  archived_by INTEGER,
  archived_at TEXT,
  UNIQUE(template_id, major, minor),
  CHECK((status='draft' AND content_hash IS NULL AND published_at IS NULL AND published_by IS NULL
          AND archived_at IS NULL AND archived_by IS NULL)
     OR (status='published' AND content_hash IS NOT NULL AND length(content_hash)=64 AND published_at IS NOT NULL AND published_by IS NOT NULL
          AND archived_at IS NULL AND archived_by IS NULL)
     OR (status='archived' AND archived_at IS NOT NULL AND archived_by IS NOT NULL
          AND ((content_hash IS NULL AND published_at IS NULL AND published_by IS NULL)
            OR (content_hash IS NOT NULL AND length(content_hash)=64 AND published_at IS NOT NULL AND published_by IS NOT NULL))))
);
CREATE TABLE checklist_sections (
  id TEXT PRIMARY KEY NOT NULL,
  template_version_id TEXT NOT NULL REFERENCES checklist_template_versions(id) ON DELETE RESTRICT,
  stable_key TEXT NOT NULL CHECK(length(trim(stable_key)) > 0),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  sort_order INTEGER NOT NULL CHECK(typeof(sort_order)='integer' AND sort_order >= 0),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  service_name TEXT NOT NULL DEFAULT '',
  object_name TEXT NOT NULL DEFAULT '',
  UNIQUE(template_version_id, stable_key),
  UNIQUE(template_version_id, sort_order)
);
CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY NOT NULL,
  section_id TEXT NOT NULL REFERENCES checklist_sections(id) ON DELETE RESTRICT,
  stable_key TEXT NOT NULL CHECK(length(trim(stable_key)) > 0),
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  equipment_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL CHECK(typeof(sort_order)='integer' AND sort_order >= 0),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  UNIQUE(section_id, stable_key),
  UNIQUE(section_id, sort_order)
);

CREATE TRIGGER checklist_current_version_insert BEFORE INSERT ON checklist_templates
WHEN NEW.current_version_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'new template must start without a current version'); END;
CREATE TRIGGER checklist_current_version_update BEFORE UPDATE OF current_version_id ON checklist_templates
WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM checklist_template_versions WHERE id=NEW.current_version_id AND template_id=NEW.id AND status='published'
)
BEGIN SELECT RAISE(ABORT, 'current version must be published and belong to template'); END;
CREATE TRIGGER checklist_template_identity BEFORE UPDATE OF id ON checklist_templates
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'template identity is immutable'); END;
CREATE TRIGGER checklist_template_delete BEFORE DELETE ON checklist_templates
WHEN EXISTS (SELECT 1 FROM checklist_template_versions WHERE template_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'template has versions'); END;
CREATE TRIGGER checklist_template_replace BEFORE INSERT ON checklist_templates
WHEN EXISTS (SELECT 1 FROM checklist_templates WHERE id=NEW.id OR code=NEW.code)
BEGIN SELECT RAISE(ABORT, 'template replacement is forbidden'); END;

CREATE TRIGGER checklist_version_insert BEFORE INSERT ON checklist_template_versions
BEGIN
  SELECT CASE WHEN NEW.status <> 'draft' THEN RAISE(ABORT, 'version must start as draft') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM checklist_templates WHERE id=NEW.template_id)
    THEN RAISE(ABORT, 'template does not exist') END;
  SELECT CASE WHEN NEW.based_on_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM checklist_template_versions WHERE id=NEW.based_on_version_id AND template_id=NEW.template_id)
    THEN RAISE(ABORT, 'invalid source version') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM checklist_template_versions
    WHERE id=NEW.id OR (template_id=NEW.template_id AND major=NEW.major AND minor=NEW.minor))
    THEN RAISE(ABORT, 'version replacement is forbidden') END;
END;
CREATE TRIGGER checklist_version_update BEFORE UPDATE ON checklist_template_versions
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.template_id IS NOT OLD.template_id
    OR NEW.major IS NOT OLD.major OR NEW.minor IS NOT OLD.minor OR NEW.version_label IS NOT OLD.version_label
    OR NEW.based_on_version_id IS NOT OLD.based_on_version_id
    OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'version identity is immutable') END;
  SELECT CASE WHEN OLD.status='archived' THEN RAISE(ABORT, 'archived version is immutable') END;
  SELECT CASE WHEN OLD.status='published' AND NOT (
    NEW.status='archived' AND NEW.name_snapshot IS OLD.name_snapshot AND NEW.content_hash IS OLD.content_hash
    AND NEW.revision IS OLD.revision AND NEW.published_by IS OLD.published_by AND NEW.published_at IS OLD.published_at
    AND NEW.archived_by IS NOT NULL AND NEW.archived_at IS NOT NULL)
    THEN RAISE(ABORT, 'published version is immutable') END;
END;
CREATE TRIGGER checklist_version_delete BEFORE DELETE ON checklist_template_versions
BEGIN SELECT RAISE(ABORT, 'version deletion is forbidden; archive instead'); END;
CREATE TRIGGER checklist_version_archive AFTER UPDATE OF status ON checklist_template_versions
WHEN NEW.status='archived'
BEGIN UPDATE checklist_templates SET current_version_id=NULL WHERE current_version_id=NEW.id; END;

CREATE TRIGGER checklist_section_insert BEFORE INSERT ON checklist_sections
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM checklist_template_versions WHERE id=NEW.template_version_id AND status='draft')
    THEN RAISE(ABORT, 'section requires draft version') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM checklist_sections WHERE id=NEW.id)
    THEN RAISE(ABORT, 'section replacement is forbidden') END;
END;
CREATE TRIGGER checklist_section_update BEFORE UPDATE ON checklist_sections
WHEN NEW.id IS NOT OLD.id OR NEW.template_version_id IS NOT OLD.template_version_id
  OR NOT EXISTS (SELECT 1 FROM checklist_template_versions WHERE id=OLD.template_version_id AND status='draft')
BEGIN SELECT RAISE(ABORT, 'section is immutable'); END;
CREATE TRIGGER checklist_section_delete BEFORE DELETE ON checklist_sections
WHEN NOT EXISTS (SELECT 1 FROM checklist_template_versions WHERE id=OLD.template_version_id AND status='draft')
BEGIN SELECT RAISE(ABORT, 'section is immutable'); END;

CREATE TRIGGER checklist_item_insert BEFORE INSERT ON checklist_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM checklist_sections s JOIN checklist_template_versions v
    ON v.id=s.template_version_id WHERE s.id=NEW.section_id AND v.status='draft')
    THEN RAISE(ABORT, 'item requires draft version') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM checklist_items WHERE id=NEW.id)
    THEN RAISE(ABORT, 'item replacement is forbidden') END;
END;
CREATE TRIGGER checklist_item_update BEFORE UPDATE ON checklist_items
WHEN NEW.id IS NOT OLD.id OR NEW.section_id IS NOT OLD.section_id
  OR NOT EXISTS (SELECT 1 FROM checklist_sections s JOIN checklist_template_versions v
    ON v.id=s.template_version_id WHERE s.id=OLD.section_id AND v.status='draft')
BEGIN SELECT RAISE(ABORT, 'item is immutable'); END;
CREATE TRIGGER checklist_item_delete BEFORE DELETE ON checklist_items
WHEN NOT EXISTS (SELECT 1 FROM checklist_sections s JOIN checklist_template_versions v
    ON v.id=s.template_version_id WHERE s.id=OLD.section_id AND v.status='draft')
BEGIN SELECT RAISE(ABORT, 'item is immutable'); END;
`;
