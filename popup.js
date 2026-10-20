const $ = s => document.querySelector(s);

const cleanHost = h => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
let sites = [];

function drawSites() {
  const ul = $("#sites");
  ul.innerHTML = "";
  sites.forEach((site, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span></span><button title="Retirer" aria-label="Retirer">×</button>`;
    li.querySelector("span").textContent = site;
    li.querySelector("button").onclick = () => { sites.splice(i, 1); saveSites(); };
    ul.appendChild(li);
  });
}
function saveSites() { chrome.storage.local.set({ interceptSites: sites }); drawSites(); refreshAddBtn(); }

let currentHost = "";
function refreshAddBtn() {
  const b = $("#add-site");
  if (!currentHost) { b.textContent = "Ouvre un site pour l'ajouter ici"; b.disabled = true; return; }
  const has = sites.includes(currentHost);
  b.textContent = has ? `${currentHost} est déjà dans la liste` : `+ Ajouter ${currentHost}`;
  b.disabled = has;
}

(async () => {
  const { enabled = true, rules = [], history = [], interceptMode = "rules", interceptSites = [] } =
    await chrome.storage.local.get(["enabled", "rules", "history", "interceptMode", "interceptSites"]);

  $("#mode").value = interceptMode;
  $("#sites-box").hidden = interceptMode !== "sites";
  sites = interceptSites;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith("http")) currentHost = cleanHost(new URL(tab.url).hostname);
  } catch {}
  drawSites();
  refreshAddBtn();

  $("#enabled").checked = enabled;
  const active = rules.filter(r => r.enabled).length;
  $("#meta").textContent = `${active} règle(s) active(s) sur ${rules.length}`;

  const ul = $("#history");
  if (!history.length) {
    ul.outerHTML = `<p class="empty">Aucun fichier renommé pour l'instant.</p>`;
  } else {
    for (const h of history) {
      const li = document.createElement("li");
      li.innerHTML = `<div class="from"></div><div class="to"></div><div class="rule"></div>`;
      li.querySelector(".from").textContent = h.from;
      li.querySelector(".to").textContent = h.to;
      li.querySelector(".rule").textContent =
        `${h.label} · ${new Date(h.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}` +
        (h.actions && h.actions.length ? ` · ${h.actions.join(", ")}` : "");
      if (h.from === h.to) li.querySelector(".from").remove();
      ul.appendChild(li);
    }
  }
})();

$("#mode").onchange = e => {
  chrome.storage.local.set({ interceptMode: e.target.value });
  $("#sites-box").hidden = e.target.value !== "sites";
};
$("#add-site").onclick = () => { if (currentHost && !sites.includes(currentHost)) { sites.push(currentHost); saveSites(); } };

$("#enabled").onchange = e => chrome.storage.local.set({ enabled: e.target.checked });
$("#open").onclick = () => chrome.runtime.openOptionsPage();
