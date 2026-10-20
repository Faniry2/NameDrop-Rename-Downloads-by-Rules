const $ = (s, el = document) => el.querySelector(s);
const rulesEl = $("#rules");
const tpl = $("#rule-tpl");
const CHIPS = ["{name}", "{date}", "{time}", "{domain}", "{n:3}", "{1}", "{name|slug}", "{yyyy}/"];

let rules = [];
let saveTimer;
let lastWritten = "";

function status(msg) {
  $("#status").textContent = msg;
  clearTimeout(status.t);
  status.t = setTimeout(() => ($("#status").textContent = ""), 1800);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    lastWritten = JSON.stringify(rules);
    await chrome.storage.local.set({ rules });
    status("Enregistré");
  }, 300);
  refreshPreviews();
}

function normalize(r) {
  return { ...newRule(), ...r, conditions: r.conditions || [], actions: r.actions || [], mappings: r.mappings || [] };
}

function testContext() {
  return buildContext({ filename: $("#t-file").value, url: $("#t-url").value, referrer: $("#t-url").value });
}

function actionsSummary(rule) {
  return rule.actions.map(a => ACTIONS[a.type]?.short || a.type).join(", ");
}

function refreshPreviews() {
  const ctx = testContext();
  let stopped = false, finalName = null, askFirst = false;
  const applied = [];

  rulesEl.querySelectorAll(".rule").forEach((card, i) => {
    const rule = rules[i];
    const m = matchRule(rule, ctx);
    const p = $(".preview", card);
    card.classList.toggle("off", !rule.enabled);
    card.classList.toggle("no-cond", !rule.conditions.length);
    card.classList.toggle("no-rename", rule.rename === false);
    card.classList.toggle("mode-table", rule.mode === "table");
    card.querySelectorAll(".map").forEach((r, j) => r.classList.toggle("hit", !!m && m.row === j));

    const applies = !!m && rule.enabled && !stopped;
    card.classList.toggle("hit", applies);
    if (applies) {
      applied.push(rule.label);
      if (rule.rename !== false && finalName === null) {
        finalName = render(rule, ctx, m, Number(rule.counterStart ?? 1));
        askFirst = !!rule.askName;
      }
      if (!rule.continue) stopped = true;
    }

    p.innerHTML = "";
    const line = document.createElement("div");
    if (!m) {
      line.className = "miss";
      line.textContent = "Ne s'applique pas au fichier de test.";
    } else {
      const name = render(rule, ctx, m, Number(rule.counterStart ?? 1));
      line.textContent = rule.rename === false ? "Correspond (pas de renommage)"
        : rule.askName ? `→ nom demandé à l'utilisateur (proposé : ${name})`
        : "→ " + name;
      if (m.row != null) line.textContent += `  (ligne ${m.row + 1})`;
      if (rule.enabled && !applies) line.textContent += "  — ignorée : une règle au-dessus s'arrête avant";
    }
    p.appendChild(line);
    if (m && rule.actions.length) {
      const acts = document.createElement("div");
      acts.className = "acts";
      acts.textContent = "Puis : " + actionsSummary(rule);
      p.appendChild(acts);
    }

    card.querySelectorAll(".cond").forEach((row, j) => {
      const c = rule.conditions[j];
      let bad = false;
      if (c.op === "regex") { try { new RegExp(c.value); } catch { bad = true; } }
      $(".c-value", row).classList.toggle("bad", bad);
    });
  });

  const res = $("#t-result");
  if (!rules.length) res.textContent = "";
  else if (!applied.length) res.textContent = "Aucune règle active ne correspond : rien ne se passe.";
  else res.textContent = `Règle(s) appliquée(s) : ${applied.join(", ")} → ${finalName ?? "nom inchangé"}${askFirst ? " (proposé, la fenêtre de saisie s'ouvrira)" : ""}`;
}

function options(map, selected) {
  return Object.entries(map).map(([v, l]) => `<option value="${v}"${v === selected ? " selected" : ""}>${l}</option>`).join("");
}

function condRow(rule, c, idx) {
  const row = document.createElement("div");
  row.className = "cond";
  row.innerHTML = `
    <select class="c-field">${options(FIELDS, c.field)}</select>
    <select class="c-op">${options(OPS, c.op)}</select>
    <input class="c-value" spellcheck="false" placeholder="valeur">
    <label class="case" title="Respecter la casse"><input type="checkbox" class="c-case"> Aa</label>
    <button class="rm" title="Retirer la condition" aria-label="Retirer la condition">×</button>`;
  $(".c-value", row).value = c.value ?? "";
  $(".c-case", row).checked = !!c.caseSensitive;
  $(".c-field", row).onchange = e => { c.field = e.target.value; save(); };
  $(".c-op", row).onchange = e => { c.op = e.target.value; save(); };
  $(".c-value", row).oninput = e => { c.value = e.target.value; save(); };
  $(".c-case", row).onchange = e => { c.caseSensitive = e.target.checked; save(); };
  $(".rm", row).onclick = () => { rule.conditions.splice(idx, 1); draw(); save(); };
  return row;
}

function mapRow(rule, mp, idx) {
  const row = document.createElement("div");
  row.className = "map";
  row.innerHTML = `
    <select class="m-field">${options(FIELDS, mp.field)}</select>
    <select class="m-op">${options(OPS, mp.op)}</select>
    <input class="m-value" spellcheck="false" placeholder="texte">
    <span class="arrow">→</span>
    <input class="m-tpl" spellcheck="false" placeholder="nouveau nom">
    <button class="rm" title="Retirer la ligne" aria-label="Retirer la ligne">×</button>`;
  $(".m-value", row).value = mp.value ?? "";
  $(".m-tpl", row).value = mp.template ?? "";
  $(".m-field", row).onchange = e => { mp.field = e.target.value; save(); };
  $(".m-op", row).onchange = e => { mp.op = e.target.value; save(); };
  $(".m-value", row).oninput = e => { mp.value = e.target.value; save(); };
  $(".m-tpl", row).oninput = e => { mp.template = e.target.value; save(); };
  $(".rm", row).onclick = () => { rule.mappings.splice(idx, 1); draw(); save(); };
  return row;
}

function actionRow(rule, a, idx) {
  const def = ACTIONS[a.type] || { label: a.type };
  const row = document.createElement("div");
  row.className = "action " + a.type;
  row.innerHTML = `<span class="a-label"></span><div class="a-fields"></div>
    <button class="rm" title="Retirer l'action" aria-label="Retirer l'action">×</button>`;
  $(".a-label", row).textContent = def.label;

  const fields = $(".a-fields", row);
  for (const [key, placeholder] of Object.entries(def.fields || {})) {
    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.title = placeholder;
    input.spellcheck = false;
    input.value = a[key] ?? "";
    input.oninput = e => { a[key] = e.target.value; save(); };
    fields.appendChild(input);
  }
  if (!fields.children.length) fields.remove();

  if (a.type === "webhook") {
    const b = document.createElement("button");
    b.className = "ghost a-perm";
    b.textContent = "Autoriser l'envoi vers ce domaine";
    b.onclick = async () => {
      let origin;
      try { origin = new URL(a.url).origin; } catch { return status("URL invalide"); }
      const ok = await chrome.permissions.request({ origins: [origin + "/*"] });
      status(ok ? "Domaine autorisé" : "Autorisation refusée");
    };
    row.appendChild(b);
  }
  if (def.note) {
    const n = document.createElement("p");
    n.className = "a-note";
    n.textContent = def.note;
    row.appendChild(n);
  }
  $(".rm", row).onclick = () => { rule.actions.splice(idx, 1); draw(); save(); };
  return row;
}

function draw() {
  rulesEl.innerHTML = "";
  if (!rules.length) {
    rulesEl.innerHTML = `<div class="empty">Aucune règle pour l'instant. Ajoute-en une pour renommer tes téléchargements ou déclencher des actions.</div>`;
    refreshPreviews();
    return;
  }
  rules.forEach((rule, i) => {
    const card = tpl.content.firstElementChild.cloneNode(true);
    const q = s => $(s, card);

    q(".r-enabled").checked = rule.enabled;
    q(".r-label").value = rule.label;
    q(".r-mode").value = rule.matchMode || "all";
    q(".r-rename").checked = rule.rename !== false;
    q(".r-template").value = rule.template;
    q(".r-ask").checked = !!rule.askName;
    q(".r-modesel").value = rule.mode || "simple";
    q(".r-modesel").onchange = e => { rule.mode = e.target.value; if (rule.mode === "table" && !rule.mappings.length) rule.mappings.push(newMapping()); draw(); save(); };
    rule.mappings.forEach((mp, j) => q(".maps").appendChild(mapRow(rule, mp, j)));
    q(".add-map").onclick = () => { rule.mappings.push(newMapping()); draw(); save(); };
    q(".bulk-add").onclick = () => {
      const rows = parseMappingList(q(".bulk-text").value);
      if (!rows.length) return status("Rien à ajouter : format texte ; nom");
      rule.mappings = rule.mappings.filter(m => m.value).concat(rows);
      draw(); save(); status(`${rows.length} ligne(s) ajoutée(s)`);
    };
    q(".tpl-caption").textContent = rule.askName ? "Nom proposé dans la fenêtre (tu pourras le modifier)" : "Nouveau nom";
    q(".r-ext").checked = rule.appendExt !== false;
    q(".r-conflict").value = rule.conflict || "uniquify";
    q(".r-start").value = rule.counterStart ?? 1;
    q(".r-reset").value = rule.counterReset || "never";
    q(".r-continue").checked = !!rule.continue;
    q(".up").disabled = i === 0;
    q(".down").disabled = i === rules.length - 1;

    q(".r-enabled").onchange = e => { rule.enabled = e.target.checked; save(); };
    q(".r-label").oninput = e => { rule.label = e.target.value; save(); };
    q(".r-mode").onchange = e => { rule.matchMode = e.target.value; save(); };
    q(".r-rename").onchange = e => { rule.rename = e.target.checked; save(); };
    q(".r-ask").onchange = e => {
      rule.askName = e.target.checked;
      q(".tpl-caption").textContent = rule.askName ? "Nom proposé dans la fenêtre (tu pourras le modifier)" : "Nouveau nom";
      save();
    };
    q(".r-template").oninput = e => { rule.template = e.target.value; save(); };
    q(".r-ext").onchange = e => { rule.appendExt = e.target.checked; save(); };
    q(".r-conflict").onchange = e => { rule.conflict = e.target.value; save(); };
    q(".r-start").oninput = e => { rule.counterStart = Number(e.target.value) || 0; save(); };
    q(".r-reset").onchange = e => { rule.counterReset = e.target.value; save(); };
    q(".r-continue").onchange = e => { rule.continue = e.target.checked; save(); };

    q(".up").onclick = () => { [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]]; draw(); save(); };
    q(".down").onclick = () => { [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]]; draw(); save(); };
    q(".del").onclick = () => {
      if (!confirm(`Supprimer la règle « ${rule.label} » ?`)) return;
      rules.splice(i, 1); draw(); save();
    };
    q(".dup").onclick = () => {
      const copy = structuredClone(rule);
      copy.id = newRule().id; copy.label += " (copie)";
      rules.splice(i + 1, 0, copy); draw(); save();
    };
    q(".add-cond").onclick = () => {
      rule.conditions.push({ field: "filename", op: "contains", value: "", caseSensitive: false });
      draw(); save();
    };
    q(".reset-counter").onclick = async () => {
      const { counters = {} } = await chrome.storage.local.get("counters");
      delete counters[rule.id];
      await chrome.storage.local.set({ counters });
      status("Compteur remis à zéro");
    };

    rule.conditions.forEach((c, j) => q(".conds").appendChild(condRow(rule, c, j)));
    rule.actions.forEach((a, j) => q(".actions").appendChild(actionRow(rule, a, j)));

    const sel = q(".add-action");
    sel.innerHTML = `<option value="">+ Ajouter une action…</option>` +
      Object.entries(ACTIONS).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join("");
    sel.onchange = e => {
      if (!e.target.value) return;
      rule.actions.push(newAction(e.target.value));
      draw(); save();
    };

    const chips = q(".chips");
    CHIPS.forEach(v => {
      const b = document.createElement("button");
      b.textContent = v;
      b.title = "Insérer";
      b.onclick = () => {
        const input = q(".r-template");
        const pos = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, pos) + v + input.value.slice(input.selectionEnd ?? pos);
        input.focus();
        input.setSelectionRange(pos + v.length, pos + v.length);
        rule.template = input.value; save();
      };
      chips.appendChild(b);
    });

    rulesEl.appendChild(card);
  });
  refreshPreviews();
}

$("#add").onclick = () => {
  rules.push(newRule());
  draw(); save();
  rulesEl.lastElementChild.scrollIntoView({ behavior: "smooth", block: "center" });
  $(".r-label", rulesEl.lastElementChild).select();
};

$("#enabled").onchange = async e => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  status(e.target.checked ? "Activé" : "Désactivé");
};

function showSitesBox(mode) { $(".intercept-box").classList.toggle("sites", mode === "sites"); }
$("#i-mode").onchange = async e => {
  showSitesBox(e.target.value);
  await chrome.storage.local.set({ interceptMode: e.target.value });
  status("Enregistré");
};
let sitesTimer;
$("#i-sites").oninput = e => {
  clearTimeout(sitesTimer);
  sitesTimer = setTimeout(async () => {
    const list = e.target.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    await chrome.storage.local.set({ interceptSites: list });
    status("Enregistré");
  }, 400);
};

$("#t-file").oninput = refreshPreviews;
$("#t-url").oninput = refreshPreviews;

$("#export").onclick = () => {
  const blob = new Blob([JSON.stringify({ version: 2, rules }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "regles-renommeur.json";
  a.click();
  URL.revokeObjectURL(a.href);
};

$("#import").onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.rules;
    if (!Array.isArray(list)) throw new Error("format");
    const replace = confirm(`${list.length} règle(s) trouvée(s).\nOK = remplacer les règles actuelles\nAnnuler = les ajouter à la suite`);
    const cleaned = list.map(r => ({ ...normalize(r), id: newRule().id }));
    rules = replace ? cleaned : rules.concat(cleaned);
    draw(); save();
  } catch {
    alert("Fichier illisible : il faut un JSON exporté depuis cette extension.");
  }
  e.target.value = "";
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.interceptMode) { $("#i-mode").value = changes.interceptMode.newValue; showSitesBox(changes.interceptMode.newValue); }
  if (changes.interceptSites && document.activeElement !== $("#i-sites")) $("#i-sites").value = (changes.interceptSites.newValue || []).join("\n");
  if (!changes.rules) return;
  if (JSON.stringify(changes.rules.newValue) === lastWritten) return; // notre propre sauvegarde
  const incoming = (changes.rules.newValue || []).map(normalize);
  if (JSON.stringify(incoming) !== JSON.stringify(rules)) { rules = incoming; draw(); status("Règles mises à jour"); }
});

(async () => {
  const data = await chrome.storage.local.get(["rules", "enabled", "interceptMode", "interceptSites"]);
  $("#i-mode").value = data.interceptMode || "rules";
  showSitesBox($("#i-mode").value);
  $("#i-sites").value = (data.interceptSites || []).join("\n");
  rules = (data.rules || []).map(normalize); // compatible avec les règles de la v1.0
  $("#enabled").checked = data.enabled !== false;
  draw();
})();
