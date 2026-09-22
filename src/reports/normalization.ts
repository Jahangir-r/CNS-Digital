export const REPORT_FIELDS = [
  "xidmet",
  "obyekt",
  "sistem",
  "nasazliq",
  "nasazliq_vaxti",
  "sebeb",
  "tedbir",
  "berpa_vaxti",
  "muraciet",
  "cavabdeh",
  "prioritet",
] as const;
export const PRIORITY_LABELS: Record<string, string> = { asagi: "Aşağı", orta: "Orta", yuksek: "Yüksək" };
export function normalizePriority(v: string): string {
  const s = (v || "").trim().toLowerCase();
  if (["asagi", "orta", "yuksek"].includes(s)) return s;
  if (s.includes("aşa") || s.includes("asa")) return "asagi";
  if (s.includes("yüks") || s.includes("yuks")) return "yuksek";
  return "orta";
}

// Normalizes historical person names without losing meaningful free-text notes.
// Canonical compact form for a person is: "Soyad A.".
const SURNAME_FIXES: Record<string, string> = {
  abbasob: "Abbasov",
  abbasov: "Abbasov",
  asyanov: "Asyanov",
  beylerov: "Bəylərov",
  cebrayilov: "Cəbrayılov",
  eliyev: "Əliyev",
  ibadov: "İbadov",
  ismayilov: "İsmayılov",
  iamayilov: "İsmayılov",
  kaysin: "Kaysın",
  kayisin: "Kaysın",
  meherremov: "Məhərrəmov",
  meherrremov: "Məhərrəmov",
  memmedov: "Məmmədov",
  novruzov: "Novruzov",
  qafarov: "Qafarov",
  salamzade: "Salamzadə",
  semedov: "Səmədov",
  suleymanov: "Süleymanov",
};

function foldName(v: string): string {
  return (v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ə/g, "e")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function canonicalSurname(v: string): string {
  const key = foldName(v);
  return SURNAME_FIXES[key] || v;
}

export function normalizePersonText(value: string, strictSinglePerson = false): string {
  let s = (value || "")
    .replace(/\r/g, " ")
    .replace(/\n+/g, ", ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
  if (!s) return "";

  // Common historical aliases / typos that occur in the supplied workbook.
  const exact = foldName(s);
  const exactMap: Record<string, string> = {
    kaysinroman: "Kaysın R.",
    kaysinr: "Kaysın R.",
    abbasobb: "Abbasov B.",
    abbasovb: "Abbasov B.",
    cebrayilovf: "Cəbrayılov F.",
    qafarovv: "Qafarov V.",
    eliyeva: "Əliyev A.",
    memmedovi: "Məmmədov İ.",
  };
  if (exactMap[exact]) return exactMap[exact];

  // Surname.Initial / Surname,Initial / Surname Initial -> Surname I.
  s = s.replace(
    /([\p{L}’'-]{2,})(?:\s+|[.,]\s*)([A-ZƏÖÜĞÇŞİI])(?=\s*\.?(?:\s|,|$))\s*\.?/gu,
    (_m, surname: string, initial: string) => `${canonicalSurname(surname)} ${initial}.`
  );

  // Remove duplicated punctuation and normalize comma spacing.
  s = s
    .replace(/\.{2,}/g, ".")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,\s*,+/g, ", ")
    .replace(/([A-ZƏÖÜĞÇŞİI]\.)\s+(?=[\p{Lu}ƏÖÜĞÇŞİI][\p{L}’'-]{2,}(?:\s|[.,]))/gu, "$1, ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,.;\s]+|[,;\s]+$/g, "");

  // Cavabdeh is expected to be one person. If a full name is supplied in
  // surname-first order, compact it to the same "Soyad A." representation.
  if (strictSinglePerson) {
    const m = s.match(/^([\p{L}’'-]{2,})\s+([\p{Lu}ƏÖÜĞÇŞİI][\p{L}’'-]+)$/u);
    if (m && /(ov|yev|li|lı|zadə|zade|in|ın|skiy|sky)$/iu.test(m[1])) {
      const initial = Array.from(m[2])[0]?.toUpperCase() || "";
      s = `${canonicalSurname(m[1])} ${initial}.`;
    }
  }
  return s;
}

function normalizeInitial(v: string): string {
  const ch = Array.from((v || "").trim())[0] || "";
  const key = ch.toLocaleLowerCase("az-AZ");
  const map: Record<string, string> = {
    "ə": "a", "e": "a",
    "ı": "i", "i": "i",
    "ö": "o", "o": "o",
    "ü": "u", "u": "u",
    "ğ": "g", "g": "g",
    "ç": "c", "c": "c",
    "ş": "s", "s": "s",
  };
  return map[key] || foldName(key).slice(0, 1);
}

export function extractPersonIdentity(value: string): { surname: string; initial: string } | null {
  const s = normalizePersonText(value || "", true).trim();
  if (!s || s.includes(",") || s.includes(";") || s.includes("/")) return null;

  const parts = s.replace(/[.]+/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  let surnameIndex = parts.findIndex((part) => {
    const key = foldName(part);
    return !!SURNAME_FIXES[key] || /(ov|yev|li|lı|lu|lü|zadə|zade|skiy|sky)$/iu.test(part);
  });

  if (surnameIndex < 0) {
    if (parts.length === 2 && Array.from(parts[1]).length <= 2) surnameIndex = 0;
    else surnameIndex = parts.length - 1;
  }

  const surname = foldName(canonicalSurname(parts[surnameIndex]));
  const other = parts.find((_p, i) => i !== surnameIndex) || "";
  const initial = normalizeInitial(other);
  if (!surname || !initial) return null;
  return { surname, initial };
}

function personIdentityKey(value: string): string {
  const id = extractPersonIdentity(value);
  return id ? `${id.surname}:${id.initial}` : "";
}

export function personMatches(accountName: string, reportName: string): boolean {
  const a = extractPersonIdentity(accountName);
  const b = extractPersonIdentity(reportName);
  return !!a && !!b && a.surname === b.surname && a.initial === b.initial;
}

export function pickReport(body: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const f of REPORT_FIELDS) out[f] = String(body[f] ?? "").trim();
  out.prioritet = normalizePriority(out.prioritet);
  out.muraciet = normalizePersonText(out.muraciet, false);
  out.cavabdeh = normalizePersonText(out.cavabdeh, true);
  return out;
}

