// Logique partagée entre le service worker et la page d'options.

const FIELDS = {
  filename: "Nom du fichier",
  name: "Nom sans extension",
  ext: "Extension",
  domain: "Domaine",
  url: "URL",
  referrer: "Site d'origine",
  mime: "Type MIME"
};

const OPS = {
  contains: "contient",
  notContains: "ne contient pas",
  equals: "est égal à",
  startsWith: "commence par",
  endsWith: "finit par",
  regex: "correspond à la regex"
};

// Actions déclenchables quand une règle correspond.
const ACTIONS = {
  notify: {
    label: "Afficher une notification", short: "notification",
    fields: { title: "Titre", message: "Message" },
    defaults: { title: "{rule}", message: "{to} ({status})" }
  },
  show: {
    label: "Afficher dans le dossier une fois terminé", short: "afficher dans le dossier"
  },
  open: {
    label: "Ouvrir le fichier une fois terminé", short: "ouvrir",
    note: "Si Chrome exige un clic, une notification avec un bouton Ouvrir s'affiche à la place."
  },
  openTab: {
    label: "Ouvrir une URL dans un onglet", short: "onglet",
    fields: { url: "URL (ex. {url} pour lire le PDF en ligne)" },
    defaults: { url: "{url}" }
  },
  webhook: {
    label: "Envoyer les infos à un webhook (POST JSON)", short: "webhook",
    fields: { url: "URL du webhook" },
    defaults: { url: "https://" },
    note: "Le JSON contient : rule, original, renamed, status, path, size, url, domain, mime, date."
  },
  erase: {
    label: "Retirer de l'historique de Chrome une fois terminé", short: "retirer de l'historique",
    note: "Le fichier reste sur le disque."
  },
  cancel: {
    label: "Bloquer le téléchargement", short: "bloquer",
    note: "Le téléchargement est annulé. Seules les notifications et webhooks de la règle sont encore exécutés."
  }
};

const FILTERS = {
  lower: s => s.toLowerCase(),
  upper: s => s.toUpperCase(),
  trim: s => s.trim(),
  slug: s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
};

const pad = (n, w = 2) => String(n).padStart(w, "0");
const NEEDS_COUNTER = /\{n[:}|]/;

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function formatSize(bytes) {
  if (!(bytes >= 0)) return "";
  const u = ["o", "Ko", "Mo", "Go"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function buildContext(item) {
  const filename = (item.filename || "").split(/[\\/]/).pop();
  const dot = filename.lastIndexOf(".");
  const url = item.finalUrl || item.url || "";
  return {
    filename,
    name: dot > 0 ? filename.slice(0, dot) : filename,
    ext: dot > 0 ? filename.slice(dot + 1) : "",
    url,
    domain: hostOf(url),
    referrer: hostOf(item.referrer || ""),
    mime: item.mime || "",
    date: item.startTime ? new Date(item.startTime) : new Date()
  };
}

function testCondition(c, ctx) {
  const value = String(ctx[c.field] ?? "");
  const pattern = c.value ?? "";
  const ci = !c.caseSensitive;
  const a = ci ? value.toLowerCase() : value;
  const b = ci ? pattern.toLowerCase() : pattern;
  switch (c.op) {
    case "contains": return { ok: a.includes(b) };
    case "notContains": return { ok: !a.includes(b) };
    case "equals": return { ok: a === b };
    case "startsWith": return { ok: a.startsWith(b) };
    case "endsWith": return { ok: a.endsWith(b) };
    case "regex": {
      let re;
      try { re = new RegExp(pattern, ci ? "i" : ""); } catch { return { ok: false }; }
      const m = value.match(re);
      return { ok: !!m, groups: m ? m.slice(1) : [] };
    }
  }
  return { ok: false };
}

// Renvoie { groups, template?, row? } si la règle s'applique, sinon null.
// Sans condition : tous les fichiers. En mode "table", il faut en plus
// qu'une ligne de la table corresponde : elle fournit le nom.
function matchRule(rule, ctx) {
  const conds = rule.conditions || [];
  let groups = [];
  if (conds.length) {
    const results = conds.map(c => {
      const r = testCondition(c, ctx);
      if (r.ok && r.groups && r.groups.length && !groups.length) groups = r.groups;
      return r.ok;
    });
    const ok = rule.matchMode === "any" ? results.some(Boolean) : results.every(Boolean);
    if (!ok) return null;
  }
  if (rule.rename !== false && rule.mode === "table") {
    const rows = rule.mappings || [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.value) continue;
      const r = testCondition(row, ctx);
      if (r.ok) return { groups: r.groups && r.groups.length ? r.groups : groups, template: row.template, row: i };
    }
    return null;
  }
  return { groups };
}

function cleanSegment(s) {
  return s.replace(/[<>:"\\|?*\x00-\x1f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
}

function sanitizePath(p) {
  return p.split("/").map(cleanSegment).filter(s => s && s !== "..").join("/").slice(0, 240);
}

// Remplace les variables d'un modèle. extra = variables supplémentaires (to, rule, status…).
function expand(template, ctx, match, counter, extra = {}, forPath = false) {
  const d = ctx.date;
  const vars = {
    name: ctx.name, ext: ctx.ext, filename: ctx.filename, url: ctx.url,
    domain: ctx.domain, referrer: ctx.referrer, mime: ctx.mime,
    yyyy: d.getFullYear(), mm: pad(d.getMonth() + 1), dd: pad(d.getDate()),
    hh: pad(d.getHours()), min: pad(d.getMinutes()), ss: pad(d.getSeconds()),
    ...extra
  };
  vars.date = `${vars.yyyy}-${vars.mm}-${vars.dd}`;
  vars.time = `${vars.hh}-${vars.min}-${vars.ss}`;

  return (template || "").replace(
    /\{([a-z0-9]+)(?::(\d+))?((?:\|[a-z]+)*)\}/gi,
    (all, key, width, filters) => {
      let val;
      if (key === "n") val = width ? pad(counter, +width) : String(counter);
      else if (/^\d+$/.test(key)) val = (match.groups || [])[+key - 1] ?? "";
      else if (key in vars) val = String(vars[key] ?? "");
      else return all;
      if (forPath) val = val.replace(/[\\/]/g, "-"); // une variable ne crée jamais de sous-dossier
      for (const f of filters.split("|").filter(Boolean)) if (FILTERS[f]) val = FILTERS[f](val);
      return val;
    }
  );
}

function render(rule, ctx, match, counter, template) {
  const t = template ?? (match && match.template != null ? match.template : rule.template);
  let out = sanitizePath(expand(t || "{name}", ctx, match || {}, counter, {}, true))
    || ctx.name || "telechargement";
  if (rule.appendExt !== false && ctx.ext &&
      !out.toLowerCase().endsWith("." + ctx.ext.toLowerCase())) {
    out += "." + ctx.ext;
  }
  return out;
}

function ruleNeedsCounter(rule) {
  const parts = [rule.rename !== false ? rule.template : ""];
  for (const m of rule.mappings || []) parts.push(m.template);
  for (const a of rule.actions || []) parts.push(a.title, a.message, a.url);
  return NEEDS_COUNTER.test(parts.join(" "));
}

function newAction(type) {
  return { type, ...(ACTIONS[type].defaults || {}) };
}

function newRule() {
  return {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
    label: "Nouvelle règle",
    enabled: true,
    matchMode: "all",
    conditions: [{ field: "ext", op: "equals", value: "pdf", caseSensitive: false }],
    rename: true,
    askName: false,
    mode: "simple",
    mappings: [],
    template: "{date}_{name}",
    appendExt: true,
    conflict: "uniquify",
    counterStart: 1,
    counterReset: "never",
    actions: [],
    continue: false
  };
}

function newMapping(value = "", template = "") {
  return { field: "filename", op: "contains", value, template, caseSensitive: false };
}

// Devine la partie "stable" d'un nom : "Facture_2026-10_0042" -> "Facture"
function guessKey(name) {
  return name.replace(/[\s_\-.]*\d.*$/, "") || name;
}

// Parse "valeur ; nouveau nom" (ou tabulation / =>), une paire par ligne.
function parseMappingList(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const parts = l.split(/\s*(?:=>|;|\t)\s*/);
    return parts.length >= 2 ? newMapping(parts[0], parts.slice(1).join(" ")) : null;
  }).filter(Boolean);
}
