import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export class TemplateError extends Error {
  constructor(public readonly status: 404 | 409 | 422, message: string) { super(message); }
}
export interface ItemInput {
  stable_key: string; name: string; equipment_name: string; technology_card: string; sort_order: number; required: boolean; active: boolean;
}
export interface SectionInput {
  stable_key: string; name: string; sort_order: number; active: boolean;
  service_name: string; object_name: string; items: ItemInput[];
}
export interface Structure { name_snapshot: string; sections: SectionInput[] }
export interface VersionRow {
  id: string; template_id: string; major: number; minor: number; version_label: string;
  status: "draft" | "published" | "archived"; based_on_version_id: string | null;
  name_snapshot: string; content_hash: string | null; revision: number;
  created_by: number; created_at: string; published_by: number | null; published_at: string | null;
  archived_by: number | null; archived_at: string | null;
}
type StoredItem = Omit<ItemInput, "active" | "required"> & { id: string; section_id: string; active: number; required: number };
type StoredSection = Omit<SectionInput, "active" | "items"> & { id: string; template_version_id: string; active: number; items: StoredItem[] };
export type Version = VersionRow & { sections: StoredSection[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TemplateError(422, "Məlumat formatı düzgün deyil");
  return value as Record<string, unknown>;
}
function text(value: unknown, optional = false): string {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || value.length > 500 || (!optional && !value.trim())) throw new TemplateError(422, "Mətn sahəsi düzgün deyil");
  return value.trim();
}
function flag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new TemplateError(422, "Bayraq dəyəri düzgün deyil");
}
function order(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TemplateError(422, "Sıra nömrəsi düzgün deyil");
  return value as number;
}
function key(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(result)) throw new TemplateError(422, "Sabit açar düzgün deyil");
  return result;
}
function technologyCard(value: unknown): string {
  const raw=text(value,true);
  if (!raw || raw==='-') return raw;
  const allowed=['S1','H1','İ1'];
  const selected=new Set(raw.split(',').map(part=>part.trim()).filter(Boolean));
  if (!selected.size || [...selected].some(part=>!allowed.includes(part))) throw new TemplateError(422,"Texnoloji kart düzgün deyil");
  return allowed.filter(part=>selected.has(part)).join(',');
}
function distinct(rows: { stable_key: string; sort_order: number }[]): void {
  if (new Set(rows.map(row => row.stable_key)).size !== rows.length || new Set(rows.map(row => row.sort_order)).size !== rows.length) {
    throw new TemplateError(422, "Açar və sıra nömrələri təkrarlanmamalıdır");
  }
}
export function validateStructure(input: unknown, publishing = false): Structure {
  const body = object(input);
  if (!Array.isArray(body.sections) || body.sections.length > 200) throw new TemplateError(422, "Mövqelər siyahısı düzgün deyil");
  let total = 0;
  const sections = body.sections.map(value => {
    const section = object(value);
    if (!Array.isArray(section.items) || section.items.length > 500) throw new TemplateError(422, "Bəndlər siyahısı düzgün deyil");
    total += section.items.length;
    const items = section.items.map(value => {
      const item = object(value);
      return { stable_key: key(item.stable_key), name: text(item.name), equipment_name: text(item.equipment_name, true), technology_card: technologyCard(item.technology_card),
        sort_order: order(item.sort_order), required: flag(item.required), active: flag(item.active) };
    }).sort((a,b) => a.sort_order - b.sort_order);
    distinct(items);
    const active = flag(section.active);
    if (publishing && active && !items.some(item => item.active)) throw new TemplateError(422, "Aktiv mövqedə ən azı bir aktiv bənd olmalıdır");
    return { stable_key: key(section.stable_key), name: text(section.name), sort_order: order(section.sort_order), active,
      service_name: text(section.service_name, true), object_name: text(section.object_name, true), items };
  }).sort((a,b) => a.sort_order - b.sort_order);
  if (total > 5000) throw new TemplateError(422, "Şablonda bənd sayı həddən artıqdır");
  distinct(sections);
  if (publishing && !sections.some(section => section.active)) throw new TemplateError(422, "Ən azı bir aktiv mövqe olmalıdır");
  return { name_snapshot: text(body.name_snapshot), sections };
}
export function structureHash(structure: Structure): string {
  // Canonical field order + sorted sections/items; database IDs/version numbers are excluded.
  return createHash("sha256").update(JSON.stringify(validateStructure(structure))).digest("hex");
}
function expectedRevision(value: unknown, version: VersionRow): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TemplateError(422, "Revision tələb olunur");
  if (value !== version.revision) throw new TemplateError(409, "Versiya dəyişdirilib. Məlumatı yeniləyin");
}

export function createTemplateService(db: Database.Database) {
  function row(id: string): VersionRow {
    const result = db.prepare("SELECT * FROM checklist_template_versions WHERE id=?").get(id) as VersionRow | undefined;
    if (!result) throw new TemplateError(404, "Şablon versiyası tapılmadı");
    return result;
  }
  function get(id: string): Version {
    const version = row(id);
    const sections = db.prepare("SELECT * FROM checklist_sections WHERE template_version_id=? ORDER BY sort_order").all(id) as StoredSection[];
    for (const section of sections) section.items = db.prepare("SELECT * FROM checklist_items WHERE section_id=? ORDER BY sort_order").all(section.id) as StoredItem[];
    return { ...version, sections };
  }
  function template(id: string) {
    const value = db.prepare("SELECT * FROM checklist_templates WHERE id=?").get(id) as { id: string; name: string; current_version_id:string|null; archived_at: string | null } | undefined;
    if (!value) throw new TemplateError(404, "Şablon tapılmadı");
    return value;
  }
  function editable(version: VersionRow) {
    if (version.status !== "draft") throw new TemplateError(409, "Yalnız qaralama dəyişdirilə bilər");
  }
  function insertVersion(templateId: string, major: number, minor: number, name: string, actor: number, basedOn: string | null) {
    const id = randomUUID();
    db.prepare(`INSERT INTO checklist_template_versions
      (id,template_id,major,minor,version_label,status,based_on_version_id,name_snapshot,created_by,created_at)
      VALUES (?,?,?,?,?,'draft',?,?,?,?)`).run(id,templateId,major,minor,`${major}.${minor}`,basedOn,name,actor,new Date().toISOString());
    return id;
  }
  function writeStructure(id: string, structure: Structure, previous?: Version) {
    // Identity is retained by stable_key on draft saves; clones supply no previous rows.
    const sections = new Map(previous?.sections.map(section => [section.stable_key, section]));
    db.prepare("DELETE FROM checklist_items WHERE section_id IN (SELECT id FROM checklist_sections WHERE template_version_id=?)").run(id);
    db.prepare("DELETE FROM checklist_sections WHERE template_version_id=?").run(id);
    const addSection = db.prepare("INSERT INTO checklist_sections VALUES (?,?,?,?,?,?,?,?)");
    const addItem = db.prepare("INSERT INTO checklist_items(id,section_id,stable_key,name,equipment_name,sort_order,required,active,technology_card) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const section of structure.sections) {
      const prior = sections.get(section.stable_key);
      const sectionId = prior?.id ?? randomUUID();
      addSection.run(sectionId,id,section.stable_key,section.name,section.sort_order,+section.active,section.service_name,section.object_name);
      const items = new Map(prior?.items.map(item => [item.stable_key, item]));
      for (const item of section.items) addItem.run(items.get(item.stable_key)?.id ?? randomUUID(),sectionId,item.stable_key,
        item.name,item.equipment_name,item.sort_order,+item.required,+item.active,item.technology_card);
    }
  }
  const create = db.transaction((input: unknown, actor: number) => {
    const body = object(input);
    const code = key(body.code), name = text(body.name);
    if (db.prepare("SELECT 1 FROM checklist_templates WHERE code=?").get(code)) throw new TemplateError(409, "Bu kod artıq mövcuddur");
    const id = randomUUID();
    db.prepare("INSERT INTO checklist_templates(id,code,name,created_by,created_at) VALUES (?,?,?,?,?)").run(id,code,name,actor,new Date().toISOString());
    return get(insertVersion(id,1,0,name,actor,null));
  });
  const update = db.transaction((id: string, input: unknown) => {
    const previous = get(id); editable(previous);
    const body = object(input); expectedRevision(body.revision, previous);
    const structure = validateStructure(body);
    writeStructure(id,structure,previous);
    db.prepare("UPDATE checklist_template_versions SET name_snapshot=?,revision=revision+1 WHERE id=?").run(structure.name_snapshot,id);
    return get(id);
  });
  const rename = db.transaction((id:string,input:unknown)=>{const t=template(id),body=object(input);if(t.current_version_id)throw new TemplateError(409,"Cari şablonun adı dəyişdirilə bilməz");const name=text(body.name);db.prepare('UPDATE checklist_templates SET name=? WHERE id=?').run(name,id);return db.prepare('SELECT * FROM checklist_templates WHERE id=?').get(id);});
  const clone = db.transaction((id: string, actor: number) => {
    const source = get(id);
    if (template(source.template_id).archived_at) throw new TemplateError(409, "Şablon arxivləşdirilib");
    const latest = db.prepare("SELECT major,minor FROM checklist_template_versions WHERE template_id=? ORDER BY major DESC,minor DESC LIMIT 1").get(source.template_id) as { major: number; minor: number };
    const newId = insertVersion(source.template_id, latest.major, latest.minor+1,source.name_snapshot,actor,id);
    writeStructure(newId,validateStructure(source));
    return get(newId);
  });
  const publish = db.transaction((id: string, revision: unknown, actor: number, makeCurrent: boolean) => {
    const version = get(id); editable(version); expectedRevision(revision,version);
    if (template(version.template_id).archived_at) throw new TemplateError(409, "Şablon arxivləşdirilib");
    const structure = validateStructure(version,true);
    // FK constraints and schema uniqueness already protect references and version/order uniqueness.
    db.prepare(`UPDATE checklist_template_versions SET status='published',content_hash=?,published_by=?,published_at=?,revision=revision+1 WHERE id=?`)
      .run(structureHash(structure),actor,new Date().toISOString(),id);
    if(makeCurrent) db.prepare("UPDATE checklist_templates SET current_version_id=? WHERE id=?").run(id,version.template_id);
    return get(id);
  });
  const activate = db.transaction((id: string, revision: unknown) => {
    const version = row(id); expectedRevision(revision,version);
    if (version.status !== "published") throw new TemplateError(409, "Yalnız dərc edilmiş versiya cari edilə bilər");
    if (template(version.template_id).archived_at) throw new TemplateError(409, "Şablon arxivləşdirilib");
    db.prepare("UPDATE checklist_templates SET current_version_id=? WHERE id=?").run(id,version.template_id);
    return get(id);
  });
  const archive = db.transaction((id: string, revision: unknown, actor: number) => {
    const version = row(id); expectedRevision(revision,version);
    if (version.status === "archived") throw new TemplateError(409, "Versiya artıq arxivləşdirilib");
    const current=db.prepare("SELECT 1 FROM checklist_templates WHERE current_version_id=?").get(id);
    if(current) throw new TemplateError(409,"Cari versiya arxivləşdirilə bilməz");
    db.prepare("UPDATE checklist_template_versions SET status='archived',archived_by=?,archived_at=? WHERE id=?")
      .run(actor,new Date().toISOString(),id);
    // The DB trigger clears current only if this exact version was current. No fallback selection.
    return get(id);
  });
  const remove = db.transaction((id: string) => {
    const version=row(id), parent=template(version.template_id);
    if(parent.current_version_id===id) throw new TemplateError(409,"Cari versiya silinə bilməz");
    if(db.prepare("SELECT 1 FROM checklist_runs WHERE template_version_id=? LIMIT 1").get(id))
      throw new TemplateError(409,"Bu versiya tarixi yoxlamalarda istifadə olunur və silinə bilməz.");
    if(db.prepare("SELECT 1 FROM checklist_template_versions WHERE based_on_version_id=? LIMIT 1").get(id))
      throw new TemplateError(409,"Bu versiyaya əsaslanan başqa versiya mövcuddur və silinə bilməz.");
    db.prepare("DELETE FROM checklist_items WHERE section_id IN (SELECT id FROM checklist_sections WHERE template_version_id=?)").run(id);
    db.prepare("DELETE FROM checklist_sections WHERE template_version_id=?").run(id);
    db.prepare("DELETE FROM checklist_template_versions WHERE id=?").run(id);
    if(!(db.prepare("SELECT 1 FROM checklist_template_versions WHERE template_id=? LIMIT 1").get(version.template_id)))
      db.prepare("DELETE FROM checklist_templates WHERE id=?").run(version.template_id);
    return {id,template_id:version.template_id,version_label:version.version_label,deleted:true};
  });
  return {
    list: () => db.prepare("SELECT * FROM checklist_templates ORDER BY created_at,id").all(),
    versions: (id: string) => { template(id); return db.prepare("SELECT * FROM checklist_template_versions WHERE template_id=? ORDER BY major DESC,minor DESC").all(id); },
    get,
    create: (input: unknown, actor: number) => create.immediate(input,actor),
    update: (id: string, input: unknown) => update.immediate(id,input),
    rename: (id:string,input:unknown)=>rename.immediate(id,input),
    clone: (id: string, actor: number) => clone.immediate(id,actor),
    publish: (id: string, revision: unknown, actor: number, makeCurrent = true) => publish.immediate(id,revision,actor,makeCurrent),
    activate: (id: string, revision: unknown) => activate.immediate(id,revision),
    archive: (id: string, revision: unknown, actor: number) => archive.immediate(id,revision,actor),
    remove: (id: string) => remove.immediate(id),
  };
}
