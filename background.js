importScripts("lib.js");

// ---------- Compteur (sérialisé pour éviter les doublons) ----------
let lock = Promise.resolve();
function nextCounter(rule) {
  const run = lock.then(async () => {
    const { counters = {} } = await chrome.storage.local.get("counters");
    const today = new Date().toISOString().slice(0, 10);
    let entry = counters[rule.id];
    if (!entry || (rule.counterReset === "daily" && entry.day !== today)) {
      entry = { v: Number(rule.counterStart ?? 1), day: today };
    }
    counters[rule.id] = { v: entry.v + 1, day: today };
    await chrome.storage.local.set({ counters });
    return entry.v;
  });
  lock = run.catch(() => {});
  return run;
}

// ---------- Historique ----------
let logLock = Promise.resolve();
function log(entry) {
  logLock = logLock.then(async () => {
    const { history = [] } = await chrome.storage.local.get("history");
    history.unshift({ ...entry, at: Date.now() });
    await chrome.storage.local.set({ history: history.slice(0, 30) });
  }).catch(() => {});
  return logLock;
}

// ---------- Notifications ----------
function notify(downloadId, title, message, withButtons) {
  const opts = { type: "basic", iconUrl: "icons/icon128.png", title: title || "Téléchargement", message: message || "" };
  if (withButtons) opts.buttons = [{ title: "Ouvrir" }, { title: "Afficher dans le dossier" }];
  chrome.notifications.create(`dl:${downloadId}:${Date.now()}`, opts);
}

async function openFile(id) {
  const r = chrome.downloads.open(id);
  if (r && r.then) await r;
  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
}

const idFrom = nid => Number(nid.split(":")[1]);

chrome.notifications.onButtonClicked.addListener(async (nid, btn) => {
  if (!nid.startsWith("dl:")) return;
  const id = idFrom(nid);
  if (btn === 0) { try { await openFile(id); } catch { chrome.downloads.show(id); } }
  else chrome.downloads.show(id);
  chrome.notifications.clear(nid);
});

chrome.notifications.onClicked.addListener(nid => {
  if (!nid.startsWith("dl:")) return;
  chrome.downloads.show(idFrom(nid));
  chrome.notifications.clear(nid);
});

// ---------- Exécution d'une action ----------
async function runAction(job, ctx, extra, downloadId, done, erased = false) {
  const vars = { ...extra, rule: job.rule };
  const fill = t => expand(t, ctx, { groups: job.groups }, job.counter, vars);
  try {
    switch (job.type) {
      case "notify":
        notify(downloadId, fill(job.title || "{rule}"), fill(job.message || "{to}"), done && !erased);
        break;
      case "openTab":
        await chrome.tabs.create({ url: fill(job.url || "{url}"), active: false });
        break;
      case "show":
        if (done) chrome.downloads.show(downloadId);
        break;
      case "open":
        if (!done) break;
        try { await openFile(downloadId); }
        catch { notify(downloadId, "Fichier prêt", `Clique sur « Ouvrir » pour lancer ${vars.to}`, !erased); }
        break;
      case "webhook": {
        const res = await fetch(fill(job.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rule: job.rule, original: ctx.filename, renamed: vars.to, status: vars.status,
            path: vars.path || null, size: vars.sizeBytes ?? null,
            url: ctx.url, domain: ctx.domain, mime: ctx.mime, date: ctx.date.toISOString()
          })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        break;
      }
    }
  } catch (e) {
    await log({ from: ctx.filename, to: vars.to, label: `Erreur — ${job.rule}`,
      actions: [`${ACTIONS[job.type]?.short || job.type} : ${e.message}`] });
  }
}

// ---------- Demander le nom à l'utilisateur ----------
const asks = new Map();
const ASK_TIMEOUT = 5 * 60 * 1000; // sans réponse : on garde le nom proposé

async function askName(info) {
  const id = crypto.randomUUID();
  return new Promise(async resolve => {
    const entry = { info, winId: null };
    const timer = setTimeout(() => entry.finish({ action: "proposed" }), ASK_TIMEOUT);
    entry.finish = answer => {
      if (!asks.has(id)) return;
      asks.delete(id);
      clearTimeout(timer);
      if (entry.winId != null) chrome.windows.remove(entry.winId).catch(() => {});
      resolve(answer);
    };
    asks.set(id, entry);

    const width = 520, height = 420, pos = {};
    try {
      const w = await chrome.windows.getLastFocused();
      pos.left = Math.round(w.left + (w.width - width) / 2);
      pos.top = Math.round(w.top + (w.height - height) / 3);
    } catch {}
    try {
      const win = await chrome.windows.create({
        url: `prompt.html?id=${id}`, type: "popup", width, height, focused: true, ...pos
      });
      entry.winId = win.id;
    } catch {
      entry.finish({ action: "proposed" });
    }
  });
}

chrome.windows.onRemoved.addListener(winId => {
  for (const entry of asks.values()) {
    if (entry.winId === winId) entry.finish({ action: "proposed" }); // fenêtre fermée = nom proposé
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ask:get") sendResponse(asks.get(msg.id)?.info ?? null);
  else if (msg?.type === "ask:answer") { asks.get(msg.id)?.finish(msg); sendResponse(true); }
  else if (msg?.type === "ask:ping") sendResponse(true);
});

// ---------- Mémoriser un nom tapé ----------
// Ajoute "si le nom contient <key> → <name>" dans la règle "Noms mémorisés",
// placée en tête de liste. La prochaine fois, plus de fenêtre pour ce fichier.
const MEMO_ID = "memorized";
async function memorize(key, name, fromRule) {
  const { rules = [] } = await chrome.storage.local.get("rules");
  let memo = rules.find(r => r.id === MEMO_ID);
  if (!memo) {
    memo = {
      ...newRule(), id: MEMO_ID, label: "Noms mémorisés", conditions: [],
      mode: "table", mappings: [], askName: false,
      appendExt: fromRule.appendExt !== false,
      continue: true // les actions des autres règles s'appliquent toujours
    };
    rules.unshift(memo);
  }
  memo.mappings = (memo.mappings || []).filter(m => m.value.toLowerCase() !== key.toLowerCase());
  memo.mappings.unshift(newMapping(key, name));
  await chrome.storage.local.set({ rules });
}

// ---------- Évaluation des règles ----------
// Faut-il intercepter ce téléchargement avec la fenêtre, même sans règle qui le demande ?
function shouldIntercept(mode, sites, ctx) {
  if (mode === "all") return true;
  if (mode !== "sites") return false;
  const hosts = [ctx.domain, ctx.referrer].filter(Boolean); // le site du bouton est souvent le referrer
  return (sites || []).some(site => {
    const d = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    return d && hosts.some(h => h === d || h.endsWith("." + d));
  });
}

// Noms proposés dans la liste déroulante de la fenêtre.
async function nameSuggestions(rules) {
  const { recentNames = [] } = await chrome.storage.local.get("recentNames");
  const fromTables = rules.flatMap(r => (r.mappings || []).map(m => m.template)).filter(Boolean);
  return [...new Set([...recentNames, ...fromTables])].slice(0, 40);
}

async function rememberRecent(name) {
  const { recentNames = [] } = await chrome.storage.local.get("recentNames");
  await chrome.storage.local.set({ recentNames: [name, ...recentNames.filter(n => n !== name)].slice(0, 20) });
}

// Ouvre la fenêtre et renvoie { cancel, name } (name = nom final rendu).
async function promptUser({ ctx, proposedName, label, appendExt, groups, counter, rules, rule }) {
  const ext = appendExt && ctx.ext ? "." + ctx.ext : "";
  const proposedBase = ext && proposedName.toLowerCase().endsWith(ext.toLowerCase())
    ? proposedName.slice(0, -ext.length) : proposedName;
  const ans = await askName({
    rule: label, proposedBase, appendExt,
    ctx: { ...ctx, date: ctx.date.toISOString() }, groups, counter,
    suggestions: await nameSuggestions(rules)
  });
  if (ans.action === "cancel") return { cancel: true, name: proposedName };
  if (ans.action === "original") return { name: ctx.filename };
  if (ans.action === "ok" && ans.name) {
    await rememberRecent(ans.name);
    if (ans.remember && ans.key) await memorize(ans.key, ans.name, rule || { appendExt });
    return { name: render(rule || { appendExt }, ctx, { groups }, counter, ans.name) };
  }
  return { name: proposedName }; // Échap, fenêtre fermée ou délai dépassé
}

async function evaluate(item) {
  const { enabled = true, rules = [], interceptMode = "rules", interceptSites = [] } =
    await chrome.storage.local.get(["enabled", "rules", "interceptMode", "interceptSites"]);
  if (!enabled) return null;
  const ctx = buildContext(item);
  let suggestion = null, cancel = false, newName = ctx.filename, any = false, asked = false;
  const deferred = [], immediate = [], applied = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const match = matchRule(rule, ctx);
    if (!match) continue;
    any = true;
    applied.push(rule.label);
    const counter = ruleNeedsCounter(rule) ? await nextCounter(rule) : 0;

    if (!suggestion && rule.rename !== false) {
      newName = render(rule, ctx, match, counter);
      if (rule.askName) {
        asked = true;
        const res = await promptUser({ ctx, proposedName: newName, label: rule.label,
          appendExt: rule.appendExt !== false, groups: match.groups, counter, rules, rule });
        newName = res.name;
        if (res.cancel) cancel = true;
      }
      suggestion = { filename: newName, conflictAction: rule.conflict || "uniquify" };
    }
    const actions = rule.actions || [];
    for (const a of actions) {
      const job = { ...a, rule: rule.label, groups: match.groups, counter };
      if (a.type === "cancel") cancel = true;
      else if (a.type === "openTab") immediate.push(job);
      else deferred.push(job);
    }
    log({ from: ctx.filename, to: newName, label: rule.label,
      actions: actions.map(a => ACTIONS[a.type]?.short || a.type) });

    if (!rule.continue) break; // sinon on passe aussi aux règles suivantes
  }

  // Mode interception : la fenêtre s'ouvre même si aucune règle ne la demande.
  if (!asked && !cancel && shouldIntercept(interceptMode, interceptSites, ctx)) {
    const res = await promptUser({ ctx, proposedName: newName,
      label: applied.length ? applied.join(", ") : "Interception", appendExt: true,
      groups: [], counter: 0, rules });
    if (res.cancel) cancel = true;
    if (res.name !== newName || !suggestion) {
      newName = res.name;
      suggestion = { filename: newName, conflictAction: suggestion?.conflictAction || "uniquify" };
    }
    if (!applied.length) log({ from: ctx.filename, to: res.cancel ? "(annulé)" : newName, label: "Interception", actions: [] });
    any = true;
  }

  return any ? { ctx, suggestion, cancel, newName, deferred, immediate } : null;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let answered = false;
  const answer = s => { if (!answered) { answered = true; s ? suggest(s) : suggest(); } };

  evaluate(item).then(async r => {
    if (!r) return answer();
    const extra = { to: r.newName, status: r.cancel ? "bloqué" : "en cours" };

    if (r.cancel) {
      answer();
      chrome.downloads.cancel(item.id);
      for (const j of r.deferred) {
        if (j.type === "notify" || j.type === "webhook") await runAction(j, r.ctx, extra, item.id, false, true);
      }
      return;
    }
    // Enregistré AVANT de laisser partir le téléchargement : un petit fichier peut finir très vite.
    if (r.deferred.length) {
      await chrome.storage.session.set({
        ["p" + item.id]: { ctx: { ...r.ctx, date: r.ctx.date.toISOString() }, newName: r.newName, jobs: r.deferred }
      });
    }
    answer(r.suggestion);
    for (const j of r.immediate) await runAction(j, r.ctx, extra, item.id, false);
  }).catch(err => { console.error("Renommeur :", err); answer(); });

  return true; // réponse asynchrone
});

// Actions à exécuter quand le téléchargement est terminé (ou a échoué).
chrome.downloads.onChanged.addListener(async delta => {
  const st = delta.state?.current;
  if (st !== "complete" && st !== "interrupted") return;
  const key = "p" + delta.id;
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) return;
  await chrome.storage.session.remove(key);

  const [item] = await chrome.downloads.search({ id: delta.id });
  const ctx = { ...pending.ctx, date: new Date(pending.ctx.date) };
  const done = st === "complete";
  const extra = {
    to: pending.newName,
    status: done ? "terminé" : "échec",
    path: item?.filename || "",
    size: item ? formatSize(item.fileSize) : "",
    sizeBytes: item?.fileSize
  };
  const erase = done && pending.jobs.some(j => j.type === "erase");

  for (const j of pending.jobs) {
    if (j.type !== "erase") await runAction(j, ctx, extra, delta.id, done, erase);
  }
  if (erase) await chrome.downloads.erase({ id: delta.id });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    await chrome.storage.local.set({ enabled: true, rules: [] });
    chrome.runtime.openOptionsPage();
  }
});
